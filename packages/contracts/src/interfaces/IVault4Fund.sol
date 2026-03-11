// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IVault4Fund — External interface for the Vault-4 investment fund
interface IVault4Fund {
    // ── Events ──────────────────────────────────────────────────────────

    event DepositQueued(address indexed investor, uint256 assets, uint256 index);
    event WithdrawQueued(address indexed investor, uint256 shares, uint256 index);
    event DepositCancelled(address indexed investor, uint256 assets, uint256 index);
    event WithdrawCancelled(address indexed investor, uint256 shares, uint256 index);
    event InstantWithdraw(address indexed investor, uint256 shares, uint256 assets);
    event Settled(
        uint256 indexed epoch,
        uint256 totalAssets,
        uint256 depositsProcessed,
        uint256 withdrawsProcessed
    );
    event NAVUpdated(uint256 newTotalAssets, uint256 timestamp);
    event PerformanceFeeCollected(uint256 feeShares, uint256 feeAssets);
    event SweptToL1(uint256 amount, uint256 newDeployedToL1);
    event L1ReturnRecorded(uint256 amount, uint256 newDeployedToL1);
    event ManagerTransferStarted(address indexed currentManager, address indexed pendingManager);
    event ManagerTransferred(address indexed previousManager, address indexed newManager);

    // ── Structs ─────────────────────────────────────────────────────────

    struct DepositRequest {
        address investor;
        uint256 assets;
        uint64 requestedAt;
    }

    struct WithdrawRequest {
        address investor;
        uint256 shares;
        uint64 requestedAt;
    }

    // ── Investor actions ────────────────────────────────────────────────

    function requestDeposit(uint256 assets) external;
    function requestWithdraw(uint256 shares) external;
    function cancelDeposit(uint256 index) external;
    function cancelWithdraw(uint256 index) external;
    function instantWithdraw(uint256 shares) external;

    // ── Manager actions ─────────────────────────────────────────────────

    function updateTotalAssets(uint256 newTotalAssets) external;
    function settle(uint256 maxDeposits, uint256 maxWithdraws) external;
    function sweepToL1(uint256 amount) external;
    function recordL1Return(uint256 amount) external;

    // ── Views ───────────────────────────────────────────────────────────

    function depositQueueLength() external view returns (uint256);
    function withdrawQueueLength() external view returns (uint256);
    function pendingDeposits() external view returns (uint256);
    function pendingWithdraws() external view returns (uint256);
    function sharePrice() external view returns (uint256);
    function availableForInstantWithdraw() external view returns (uint256);
}
