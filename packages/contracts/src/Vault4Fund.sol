// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {NAVLib} from "./lib/NAVLib.sol";
import {IVault4Fund} from "./interfaces/IVault4Fund.sol";

/// @title Vault4Fund — ERC-4626 investment vault for Vault-4 on HyperEVM
/// @notice Accepts USDC deposits, issues proportional shares, queues settlement daily.
///         Manager bridges funds to Hyperliquid L1 for automated vault investing.
/// @dev NAV is manager-reported via updateTotalAssets(). Shares are transferable ERC20.
contract Vault4Fund is ERC4626, Pausable, ReentrancyGuard, IVault4Fund {
    using SafeERC20 for IERC20;

    // ── Constants ────────────────────────────────────────────────────────

    uint256 public constant MIN_AMOUNT = 10e6; // 10 USDC (6 decimals)
    uint256 public constant PERFORMANCE_FEE_BPS = 1000; // 10%
    uint256 public constant MAX_NAV_AGE = 1 hours; // NAV must be fresh for settlement

    /// @dev USDC system address on HyperEVM — ERC20 transfer here bridges to L1
    address public constant USDC_SYSTEM_ADDRESS =
        0x2000000000000000000000000000000000000000;

    // ── State ────────────────────────────────────────────────────────────

    address public manager;
    address public pendingManager;

    /// @notice Manager-reported total value of all assets (idle + deployed), in USDC (6 dec)
    uint256 internal _totalAssets;

    /// @notice USDC currently deployed to L1 (accounting ledger), in USDC (6 dec)
    uint256 public deployedToL1;

    /// @notice Sum of queued deposit USDC not yet settled
    uint256 public pendingDepositAssets;

    /// @notice Sum of queued withdrawal shares not yet settled
    uint256 public pendingWithdrawShares;

    /// @notice High-water mark for performance fee (share price in 18-dec precision)
    uint256 public highWaterMark;

    /// @notice Timestamp of last NAV update
    uint256 public lastNAVUpdate;

    /// @notice Settlement epoch counter
    uint256 public epoch;

    // ── Queues ───────────────────────────────────────────────────────────

    DepositRequest[] internal _depositQueue;
    uint256 public depositQueueHead;

    WithdrawRequest[] internal _withdrawQueue;
    uint256 public withdrawQueueHead;

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyManager() {
        require(msg.sender == manager, "Vault4: not manager");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────

    /// @param usdc USDC token address on HyperEVM
    /// @param manager_ Initial manager address
    constructor(
        IERC20 usdc,
        address manager_
    )
        ERC4626(usdc)
        ERC20("Vault-4 Fund Shares", "V4FUND")
    {
        require(manager_ != address(0), "Vault4: zero manager");
        manager = manager_;
        highWaterMark = NAVLib.PRECISION; // 1.0 initial share price
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ERC-4626 Overrides
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Returns manager-reported total assets, NOT the contract's USDC balance
    function totalAssets() public view override returns (uint256) {
        return _totalAssets;
    }

    /// @dev ERC-4626 compliance: return 0 since standard deposit/mint/withdraw/redeem are disabled
    function maxDeposit(address) public pure override returns (uint256) { return 0; }
    function maxMint(address) public pure override returns (uint256) { return 0; }
    function maxWithdraw(address) public pure override returns (uint256) { return 0; }
    function maxRedeem(address) public pure override returns (uint256) { return 0; }

    /// @dev Disable standard ERC-4626 deposit — use requestDeposit() instead
    function deposit(uint256, address) public pure override returns (uint256) {
        revert("Vault4: use requestDeposit()");
    }

    /// @dev Disable standard ERC-4626 mint
    function mint(uint256, address) public pure override returns (uint256) {
        revert("Vault4: use requestDeposit()");
    }

    /// @dev Disable standard ERC-4626 withdraw — use requestWithdraw() instead
    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert("Vault4: use requestWithdraw()");
    }

    /// @dev Disable standard ERC-4626 redeem
    function redeem(uint256, address, address) public pure override returns (uint256) {
        revert("Vault4: use requestWithdraw()");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Investor Actions
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Queue a deposit. USDC is transferred immediately and held until settlement.
    /// @param assets USDC amount (6 decimals, minimum 10 USDC)
    function requestDeposit(uint256 assets) external nonReentrant whenNotPaused {
        require(assets >= MIN_AMOUNT, "Vault4: below minimum");

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);

        uint256 index = _depositQueue.length;
        _depositQueue.push(
            DepositRequest({
                investor: msg.sender,
                assets: assets,
                requestedAt: uint64(block.timestamp)
            })
        );
        pendingDepositAssets += assets;

        emit DepositQueued(msg.sender, assets, index);
    }

    /// @notice Queue a withdrawal. Shares are transferred to the contract until settlement.
    /// @param shares Number of shares to redeem (must be worth >= 10 USDC at current NAV)
    function requestWithdraw(uint256 shares) external nonReentrant whenNotPaused {
        require(shares > 0, "Vault4: zero shares");
        uint256 assetsOut = convertToAssets(shares);
        require(assetsOut >= MIN_AMOUNT, "Vault4: below minimum");

        // Transfer shares from investor to contract (held until settlement)
        _transfer(msg.sender, address(this), shares);

        uint256 index = _withdrawQueue.length;
        _withdrawQueue.push(
            WithdrawRequest({
                investor: msg.sender,
                shares: shares,
                requestedAt: uint64(block.timestamp)
            })
        );
        pendingWithdrawShares += shares;

        emit WithdrawQueued(msg.sender, shares, index);
    }

    /// @notice Cancel a pending deposit (only if not yet settled)
    /// @dev Deliberately NOT gated by whenNotPaused — investors must be able to
    ///      recover their USDC even when the vault is paused.
    /// @param index Index in the deposit queue
    function cancelDeposit(uint256 index) external nonReentrant {
        require(index >= depositQueueHead, "Vault4: already settled");
        require(index < _depositQueue.length, "Vault4: invalid index");

        DepositRequest storage req = _depositQueue[index];
        require(req.investor == msg.sender, "Vault4: not your request");
        require(req.assets > 0, "Vault4: already cancelled");

        uint256 assets = req.assets;
        req.assets = 0; // mark cancelled

        pendingDepositAssets -= assets;
        IERC20(asset()).safeTransfer(msg.sender, assets);

        emit DepositCancelled(msg.sender, assets, index);
    }

    /// @notice Cancel a pending withdrawal (only if not yet settled)
    /// @dev Deliberately NOT gated by whenNotPaused — investors must be able to
    ///      recover their shares even when the vault is paused.
    /// @param index Index in the withdraw queue
    function cancelWithdraw(uint256 index) external nonReentrant {
        require(index >= withdrawQueueHead, "Vault4: already settled");
        require(index < _withdrawQueue.length, "Vault4: invalid index");

        WithdrawRequest storage req = _withdrawQueue[index];
        require(req.investor == msg.sender, "Vault4: not your request");
        require(req.shares > 0, "Vault4: already cancelled");

        uint256 shares = req.shares;
        req.shares = 0; // mark cancelled

        pendingWithdrawShares -= shares;
        _transfer(address(this), msg.sender, shares);

        emit WithdrawCancelled(msg.sender, shares, index);
    }

    /// @notice Instant withdrawal if contract has enough idle USDC
    /// @dev Reduces _totalAssets immediately. Manager must account for instant withdrawals
    ///      when calling updateTotalAssets() to avoid double-counting or understating NAV.
    /// @param shares Number of shares to redeem
    function instantWithdraw(uint256 shares) external nonReentrant whenNotPaused {
        require(shares > 0, "Vault4: zero shares");
        uint256 assetsOut = convertToAssets(shares);
        require(assetsOut >= MIN_AMOUNT, "Vault4: below minimum");

        uint256 available = _availableForInstantWithdraw();
        require(assetsOut <= available, "Vault4: insufficient liquidity");

        // Burn shares and transfer USDC
        _burn(msg.sender, shares);
        _totalAssets -= assetsOut;

        IERC20(asset()).safeTransfer(msg.sender, assetsOut);

        emit InstantWithdraw(msg.sender, shares, assetsOut);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Manager Actions
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Report the current total NAV (idle + deployed assets)
    /// @dev Must reflect the INVESTED portfolio value, EXCLUDING pendingDepositAssets
    ///      (those belong to queued investors and will be added during settle).
    ///      TRUST ASSUMPTION: manager is trusted to report accurate NAV.
    /// @param newTotalAssets Total value in USDC (6 decimals)
    function updateTotalAssets(uint256 newTotalAssets) external onlyManager {
        require(newTotalAssets >= deployedToL1, "Vault4: NAV below deployed");
        _totalAssets = newTotalAssets;
        lastNAVUpdate = block.timestamp;
        emit NAVUpdated(newTotalAssets, block.timestamp);
    }

    /// @notice Process queued deposits and withdrawals at current NAV
    /// @dev Must call updateTotalAssets() first. Only processes requests submitted
    ///      before the last NAV update (anti-frontrunning).
    /// @param maxDeposits Maximum deposit requests to process (gas safety)
    /// @param maxWithdraws Maximum withdraw requests to process (gas safety)
    function settle(
        uint256 maxDeposits,
        uint256 maxWithdraws
    ) external onlyManager nonReentrant {
        require(lastNAVUpdate > 0, "Vault4: NAV not set");
        require(
            block.timestamp - lastNAVUpdate <= MAX_NAV_AGE,
            "Vault4: stale NAV"
        );

        uint256 navTimestamp = lastNAVUpdate;

        // ── Step 1: Process withdrawals first (honor exits before entries) ──
        uint256 withdrawsProcessed = _settleWithdraws(maxWithdraws, navTimestamp);

        // ── Step 2: Process deposits ──
        uint256 depositsProcessed = _settleDeposits(maxDeposits, navTimestamp);

        // ── Step 3: Collect performance fee AFTER settlements ──
        // Fee is minted as new shares which dilutes share price. By collecting
        // after settlements, depositors and withdrawers transact at the
        // pre-dilution price, preventing systematic value transfer.
        _collectPerformanceFee();

        epoch++;
        emit Settled(epoch, _totalAssets, depositsProcessed, withdrawsProcessed);
    }

    /// @notice Transfer USDC from contract to L1 via system address bridge
    /// @param amount USDC amount to bridge (must leave enough for pending withdrawals)
    function sweepToL1(uint256 amount) external onlyManager {
        require(amount > 0, "Vault4: zero amount");

        uint256 idle = _idleUsdc();
        // Reserve enough for pending withdraw value
        uint256 pendingWithdrawValue = convertToAssets(pendingWithdrawShares);
        require(
            idle >= amount + pendingWithdrawValue,
            "Vault4: would leave insufficient liquidity"
        );

        deployedToL1 += amount;
        IERC20(asset()).safeTransfer(USDC_SYSTEM_ADDRESS, amount);

        emit SweptToL1(amount, deployedToL1);
    }

    /// @notice Record USDC returned from L1 to the contract
    /// @dev Call after USDC arrives at the contract address from L1
    /// @param amount USDC amount that was returned
    function recordL1Return(uint256 amount) external onlyManager {
        require(amount <= deployedToL1, "Vault4: exceeds deployed");
        deployedToL1 -= amount;
        emit L1ReturnRecorded(amount, deployedToL1);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Admin
    // ═══════════════════════════════════════════════════════════════════════

    function pause() external onlyManager {
        _pause();
    }

    function unpause() external onlyManager {
        _unpause();
    }

    /// @notice Start two-step manager transfer
    function transferManager(address newManager) external onlyManager {
        require(newManager != address(0), "Vault4: zero address");
        pendingManager = newManager;
        emit ManagerTransferStarted(manager, newManager);
    }

    /// @notice Accept manager role (called by pending manager)
    function acceptManager() external {
        require(msg.sender == pendingManager, "Vault4: not pending manager");
        emit ManagerTransferred(manager, msg.sender);
        manager = msg.sender;
        pendingManager = address(0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  View Functions
    // ═══════════════════════════════════════════════════════════════════════

    function depositQueueLength() external view returns (uint256) {
        return _depositQueue.length;
    }

    function withdrawQueueLength() external view returns (uint256) {
        return _withdrawQueue.length;
    }

    function pendingDeposits() external view returns (uint256) {
        return pendingDepositAssets;
    }

    function pendingWithdraws() external view returns (uint256) {
        return pendingWithdrawShares;
    }

    function sharePrice() external view returns (uint256) {
        return NAVLib.computeSharePrice(_totalAssets, totalSupply());
    }

    function availableForInstantWithdraw() external view returns (uint256) {
        return _availableForInstantWithdraw();
    }

    function getDepositRequest(
        uint256 index
    ) external view returns (DepositRequest memory) {
        return _depositQueue[index];
    }

    function getWithdrawRequest(
        uint256 index
    ) external view returns (WithdrawRequest memory) {
        return _withdrawQueue[index];
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Internal
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Idle USDC = contract balance minus pending deposit collateral
    function _idleUsdc() internal view returns (uint256) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        if (balance <= pendingDepositAssets) return 0;
        return balance - pendingDepositAssets;
    }

    /// @dev USDC available for instant withdrawal (idle minus pending withdraw reserves)
    function _availableForInstantWithdraw() internal view returns (uint256) {
        uint256 idle = _idleUsdc();
        uint256 pendingWithdrawValue = convertToAssets(pendingWithdrawShares);
        if (idle <= pendingWithdrawValue) return 0;
        return idle - pendingWithdrawValue;
    }

    /// @dev Mint performance fee shares to manager if NAV exceeds high-water mark
    function _collectPerformanceFee() internal {
        uint256 supply = totalSupply();
        if (supply == 0) return;

        uint256 currentPrice = NAVLib.computeSharePrice(_totalAssets, supply);

        (uint256 feeAssets, uint256 newHWM) = NAVLib.computePerformanceFee(
            currentPrice,
            highWaterMark,
            supply,
            PERFORMANCE_FEE_BPS
        );

        if (feeAssets == 0) return;

        // Always advance HWM when above it, even if feeShares rounds to zero.
        // This prevents re-counting the same profit on subsequent settlements.
        highWaterMark = newHWM;

        // Mint shares worth feeAssets to manager at current price
        uint256 feeShares = convertToShares(feeAssets);
        if (feeShares == 0) return;

        _mint(manager, feeShares);

        emit PerformanceFeeCollected(feeShares, feeAssets);
    }

    /// @dev Process deposit queue entries submitted before navTimestamp
    function _settleDeposits(
        uint256 maxItems,
        uint256 navTimestamp
    ) internal returns (uint256 processed) {
        uint256 head = depositQueueHead;
        uint256 len = _depositQueue.length;

        for (uint256 i = head; i < len && processed < maxItems; i++) {
            DepositRequest storage req = _depositQueue[i];

            // Skip cancelled requests
            if (req.assets == 0) {
                if (i == head) head++;
                continue;
            }

            // Anti-frontrunning: only process requests submitted before NAV update
            if (req.requestedAt >= navTimestamp) break;

            uint256 shares = convertToShares(req.assets);
            if (shares == 0) {
                // Edge case: tiny deposit at high share price — refund USDC
                uint256 refund = req.assets;
                req.assets = 0;
                pendingDepositAssets -= refund;
                IERC20(asset()).safeTransfer(req.investor, refund);
                if (i == head) head++;
                continue;
            }

            // USDC is already in the contract — just mint shares and update NAV
            _mint(req.investor, shares);
            _totalAssets += req.assets;
            pendingDepositAssets -= req.assets;
            req.assets = 0; // mark settled

            if (i == head) head++;
            processed++;
        }

        // Advance head past all settled/cancelled entries
        while (head < len && _depositQueue[head].assets == 0) {
            head++;
        }
        depositQueueHead = head;
    }

    /// @dev Process withdraw queue entries submitted before navTimestamp
    function _settleWithdraws(
        uint256 maxItems,
        uint256 navTimestamp
    ) internal returns (uint256 processed) {
        uint256 head = withdrawQueueHead;
        uint256 len = _withdrawQueue.length;

        for (uint256 i = head; i < len && processed < maxItems; i++) {
            WithdrawRequest storage req = _withdrawQueue[i];

            // Skip cancelled requests
            if (req.shares == 0) {
                if (i == head) head++;
                continue;
            }

            // Anti-frontrunning: only process requests submitted before NAV update
            if (req.requestedAt >= navTimestamp) break;

            uint256 assetsOut = convertToAssets(req.shares);

            // Check liquidity — if not enough, stop processing withdrawals
            uint256 idle = _idleUsdc();
            if (assetsOut > idle) break;

            // Burn shares held by contract and transfer USDC
            _burn(address(this), req.shares);
            _totalAssets -= assetsOut;
            pendingWithdrawShares -= req.shares;
            req.shares = 0; // mark settled

            IERC20(asset()).safeTransfer(req.investor, assetsOut);

            if (i == head) head++;
            processed++;
        }

        // Advance head past all settled/cancelled entries
        while (head < len && _withdrawQueue[head].shares == 0) {
            head++;
        }
        withdrawQueueHead = head;
    }
}
