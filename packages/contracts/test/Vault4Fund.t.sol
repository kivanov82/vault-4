// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {Vault4Fund} from "../src/Vault4Fund.sol";
import {IVault4Fund} from "../src/interfaces/IVault4Fund.sol";
import {NAVLib} from "../src/lib/NAVLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Vault4FundTest is Test {
    Vault4Fund public vault;
    ERC20Mock public usdc;

    address public manager = makeAddr("manager");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    uint256 constant USDC_DECIMALS = 6;
    uint256 constant ONE_USDC = 1e6;
    uint256 constant TEN_USDC = 10e6;
    uint256 constant HUNDRED_USDC = 100e6;
    uint256 constant THOUSAND_USDC = 1000e6;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        vault = new Vault4Fund(IERC20(address(usdc)), manager);

        // Fund test accounts
        usdc.mint(alice, 10_000 * ONE_USDC);
        usdc.mint(bob, 10_000 * ONE_USDC);
        usdc.mint(manager, 10_000 * ONE_USDC);

        // Approve vault
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(manager);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Construction
    // ═══════════════════════════════════════════════════════════════════

    function test_constructor() public view {
        assertEq(vault.manager(), manager);
        assertEq(vault.asset(), address(usdc));
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.highWaterMark(), NAVLib.PRECISION);
        assertEq(vault.epoch(), 0);
    }

    function test_constructor_zeroManager_reverts() public {
        vm.expectRevert("Vault4: zero manager");
        new Vault4Fund(IERC20(address(usdc)), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-4626 disabled standard functions
    // ═══════════════════════════════════════════════════════════════════

    function test_maxFunctions_returnZero() public view {
        assertEq(vault.maxDeposit(alice), 0);
        assertEq(vault.maxMint(alice), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);
    }

    function test_deposit_disabled() public {
        vm.prank(alice);
        vm.expectRevert("Vault4: use requestDeposit()");
        vault.deposit(HUNDRED_USDC, alice);
    }

    function test_mint_disabled() public {
        vm.prank(alice);
        vm.expectRevert("Vault4: use requestDeposit()");
        vault.mint(HUNDRED_USDC, alice);
    }

    function test_withdraw_disabled() public {
        vm.prank(alice);
        vm.expectRevert("Vault4: use requestWithdraw()");
        vault.withdraw(HUNDRED_USDC, alice, alice);
    }

    function test_redeem_disabled() public {
        vm.prank(alice);
        vm.expectRevert("Vault4: use requestWithdraw()");
        vault.redeem(HUNDRED_USDC, alice, alice);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Request Deposit
    // ═══════════════════════════════════════════════════════════════════

    function test_requestDeposit() public {
        vm.prank(alice);
        vault.requestDeposit(HUNDRED_USDC);

        assertEq(vault.depositQueueLength(), 1);
        assertEq(vault.pendingDeposits(), HUNDRED_USDC);
        assertEq(usdc.balanceOf(address(vault)), HUNDRED_USDC);

        IVault4Fund.DepositRequest memory req = vault.getDepositRequest(0);
        assertEq(req.investor, alice);
        assertEq(req.assets, HUNDRED_USDC);
    }

    function test_requestDeposit_belowMinimum_reverts() public {
        vm.prank(alice);
        vm.expectRevert("Vault4: below minimum");
        vault.requestDeposit(5 * ONE_USDC); // 5 USDC < 10 USDC minimum
    }

    function test_requestDeposit_whenPaused_reverts() public {
        vm.prank(manager);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert();
        vault.requestDeposit(HUNDRED_USDC);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Cancel Deposit
    // ═══════════════════════════════════════════════════════════════════

    function test_cancelDeposit() public {
        vm.prank(alice);
        vault.requestDeposit(HUNDRED_USDC);

        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.cancelDeposit(0);

        assertEq(usdc.balanceOf(alice), balBefore + HUNDRED_USDC);
        assertEq(vault.pendingDeposits(), 0);
    }

    function test_cancelDeposit_notOwner_reverts() public {
        vm.prank(alice);
        vault.requestDeposit(HUNDRED_USDC);

        vm.prank(bob);
        vm.expectRevert("Vault4: not your request");
        vault.cancelDeposit(0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Settlement — Deposits
    // ═══════════════════════════════════════════════════════════════════

    function test_settle_deposits_firstDepositor() public {
        // Alice deposits 100 USDC
        vm.prank(alice);
        vault.requestDeposit(HUNDRED_USDC);

        // Advance time so request is before NAV update
        vm.warp(block.timestamp + 1);

        // Manager sets NAV (0 existing + 100 pending not counted yet)
        vm.startPrank(manager);
        vault.updateTotalAssets(0);
        vault.settle(100, 100);
        vm.stopPrank();

        // Alice should have shares worth 100 USDC
        assertGt(vault.balanceOf(alice), 0);
        assertEq(vault.totalAssets(), HUNDRED_USDC);
        assertEq(vault.pendingDeposits(), 0);
        assertEq(vault.epoch(), 1);
    }

    function test_settle_deposits_secondDepositor_fairPrice() public {
        // First: Alice deposits 100 USDC
        vm.prank(alice);
        vault.requestDeposit(HUNDRED_USDC);
        vm.warp(block.timestamp + 1);

        vm.startPrank(manager);
        vault.updateTotalAssets(0);
        vault.settle(100, 100);
        vm.stopPrank();

        uint256 aliceShares = vault.balanceOf(alice);
        // NAV is now 100 USDC

        // Manager invests, NAV grows to 120 USDC (20% profit)
        vm.warp(block.timestamp + 1 days);

        // Bob deposits 100 USDC
        vm.prank(bob);
        vault.requestDeposit(HUNDRED_USDC);
        vm.warp(block.timestamp + 1);

        // Manager reports NAV as 120 USDC (before Bob's deposit)
        vm.startPrank(manager);
        vault.updateTotalAssets(120 * ONE_USDC);
        vault.settle(100, 100);
        vm.stopPrank();

        uint256 bobShares = vault.balanceOf(bob);

        // Bob should have fewer shares than Alice (entered at higher price)
        assertLt(bobShares, aliceShares);

        // Total NAV should be 220 USDC
        assertEq(vault.totalAssets(), 220 * ONE_USDC);
    }

    function test_settle_antiFrontrun() public {
        // Alice deposits before NAV update
        vm.prank(alice);
        vault.requestDeposit(HUNDRED_USDC);
        vm.warp(block.timestamp + 1);

        // Manager updates NAV
        vm.prank(manager);
        vault.updateTotalAssets(0);

        // Bob deposits AFTER NAV update (same timestamp)
        vm.prank(bob);
        vault.requestDeposit(HUNDRED_USDC);

        // Settle — Bob's request should NOT be processed (requestedAt >= navTimestamp)
        vm.prank(manager);
        vault.settle(100, 100);

        assertGt(vault.balanceOf(alice), 0, "Alice should have shares");
        assertEq(vault.balanceOf(bob), 0, "Bob should not have shares yet");
        assertEq(vault.pendingDeposits(), HUNDRED_USDC, "Bob's deposit still pending");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Request Withdraw
    // ═══════════════════════════════════════════════════════════════════

    function test_requestWithdraw() public {
        // Setup: Alice deposits and settles (NAV=0 for first deposit)
        _depositAndSettle(alice, HUNDRED_USDC, 0);

        uint256 aliceShares = vault.balanceOf(alice);

        vm.prank(alice);
        vault.requestWithdraw(aliceShares);

        assertEq(vault.withdrawQueueLength(), 1);
        assertEq(vault.balanceOf(alice), 0); // shares transferred to vault
        assertEq(vault.balanceOf(address(vault)), aliceShares);
    }

    function test_requestWithdraw_belowMinimum_reverts() public {
        _depositAndSettle(alice, HUNDRED_USDC, 0);

        // Try to withdraw tiny amount
        vm.prank(alice);
        vm.expectRevert("Vault4: below minimum");
        vault.requestWithdraw(1); // 1 share = ~1 USDC < 10 USDC minimum
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Settlement — Withdrawals
    // ═══════════════════════════════════════════════════════════════════

    function test_settle_withdrawal() public {
        // Alice deposits 100 USDC (first deposit, NAV=0)
        _depositAndSettle(alice, HUNDRED_USDC, 0);

        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.requestWithdraw(aliceShares);
        vm.warp(block.timestamp + 1);

        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        // NAV = 100 USDC (the 100 USDC is still idle in the contract)
        vm.startPrank(manager);
        vault.updateTotalAssets(HUNDRED_USDC);
        vault.settle(100, 100);
        vm.stopPrank();

        assertEq(vault.balanceOf(alice), 0);
        assertGt(usdc.balanceOf(alice), aliceUsdcBefore);
    }

    function test_settle_withdrawal_insufficientLiquidity_partial() public {
        // Alice deposits 100 USDC (first deposit, NAV=0)
        _depositAndSettle(alice, HUNDRED_USDC, 0);

        // Bob deposits 100 USDC (NAV=100 from Alice's deposit)
        vm.prank(bob);
        vault.requestDeposit(HUNDRED_USDC);
        vm.warp(block.timestamp + 1);
        vm.startPrank(manager);
        vault.updateTotalAssets(HUNDRED_USDC);
        vault.settle(100, 100);
        vm.stopPrank();

        // Manager sweeps 100 USDC to L1 (leaving ~100 idle)
        vm.prank(manager);
        vault.sweepToL1(100 * ONE_USDC);

        // Both request withdrawal
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 bobShares = vault.balanceOf(bob);

        vm.prank(alice);
        vault.requestWithdraw(aliceShares);
        vm.prank(bob);
        vault.requestWithdraw(bobShares);
        vm.warp(block.timestamp + 1);

        // NAV = 200 total but only ~100 USDC idle in contract
        vm.startPrank(manager);
        vault.updateTotalAssets(200 * ONE_USDC);
        vault.settle(100, 100);
        vm.stopPrank();

        // Only Alice should be settled (first in queue, contract has enough for one)
        assertEq(vault.pendingWithdraws(), bobShares, "Bob's withdrawal still pending");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Instant Withdraw
    // ═══════════════════════════════════════════════════════════════════

    function test_instantWithdraw() public {
        // Alice deposits 100 USDC (first deposit, NAV=0)
        _depositAndSettle(alice, HUNDRED_USDC, 0);

        // NAV = 100 USDC (all idle in contract)
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vault.instantWithdraw(aliceShares);

        assertEq(vault.balanceOf(alice), 0);
        assertApproxEqAbs(
            usdc.balanceOf(alice) - aliceUsdcBefore,
            HUNDRED_USDC,
            1 // rounding tolerance
        );
    }

    function test_instantWithdraw_insufficientLiquidity_reverts() public {
        _depositAndSettle(alice, HUNDRED_USDC, 0);

        // Sweep all to L1
        vm.prank(manager);
        vault.sweepToL1(HUNDRED_USDC);

        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert("Vault4: insufficient liquidity");
        vault.instantWithdraw(aliceShares);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Performance Fee
    // ═══════════════════════════════════════════════════════════════════

    function test_performanceFee_onProfit() public {
        // Alice deposits 1000 USDC (first deposit, NAV=0)
        _depositAndSettle(alice, THOUSAND_USDC, 0);

        uint256 managerSharesBefore = vault.balanceOf(manager);

        // NAV grows to 1100 (10% profit = 100 USDC, fee = 10 USDC)
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(manager);
        vault.updateTotalAssets(1100 * ONE_USDC);
        vault.settle(0, 0); // no queue items, just collect fee
        vm.stopPrank();

        uint256 managerSharesAfter = vault.balanceOf(manager);
        assertGt(managerSharesAfter, managerSharesBefore, "Manager should receive fee shares");
    }

    function test_performanceFee_noFeeOnLoss() public {
        _depositAndSettle(alice, THOUSAND_USDC, 0);

        uint256 managerSharesBefore = vault.balanceOf(manager);

        // NAV drops to 900 (loss)
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(manager);
        vault.updateTotalAssets(900 * ONE_USDC);
        vault.settle(0, 0);
        vm.stopPrank();

        assertEq(
            vault.balanceOf(manager),
            managerSharesBefore,
            "No fee on loss"
        );
    }

    function test_performanceFee_hwmRatchet() public {
        _depositAndSettle(alice, THOUSAND_USDC, 0);

        // NAV goes up to 1100
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(manager);
        vault.updateTotalAssets(1100 * ONE_USDC);
        vault.settle(0, 0);

        uint256 hwm1 = vault.highWaterMark();

        // NAV drops to 1050
        vm.warp(block.timestamp + 1 days);
        vault.updateTotalAssets(1050 * ONE_USDC);
        vault.settle(0, 0);

        // HWM should NOT decrease
        assertEq(vault.highWaterMark(), hwm1, "HWM should not decrease");

        // NAV recovers to 1080 (still below HWM)
        vm.warp(block.timestamp + 1 days);
        vault.updateTotalAssets(1080 * ONE_USDC);

        uint256 managerSharesBefore = vault.balanceOf(manager);
        vault.settle(0, 0);

        assertEq(
            vault.balanceOf(manager),
            managerSharesBefore,
            "No fee below HWM"
        );

        // NAV goes above HWM to 1200
        vm.warp(block.timestamp + 1 days);
        vault.updateTotalAssets(1200 * ONE_USDC);
        vault.settle(0, 0);
        vm.stopPrank();

        assertGt(vault.balanceOf(manager), managerSharesBefore, "Fee on new high");
        assertGt(vault.highWaterMark(), hwm1, "HWM advanced");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Sweep to L1
    // ═══════════════════════════════════════════════════════════════════

    function test_sweepToL1() public {
        _depositAndSettle(alice, HUNDRED_USDC, 0);

        uint256 vaultBalBefore = usdc.balanceOf(address(vault));

        vm.prank(manager);
        vault.sweepToL1(50 * ONE_USDC);

        assertEq(vault.deployedToL1(), 50 * ONE_USDC);
        assertEq(usdc.balanceOf(address(vault)), vaultBalBefore - 50 * ONE_USDC);
    }

    function test_sweepToL1_protectsPendingWithdraws() public {
        _depositAndSettle(alice, HUNDRED_USDC, 0);

        // Alice queues a withdrawal
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.requestWithdraw(aliceShares);

        // Manager tries to sweep everything — should fail
        vm.prank(manager);
        vm.expectRevert("Vault4: would leave insufficient liquidity");
        vault.sweepToL1(HUNDRED_USDC);
    }

    function test_sweepToL1_notManager_reverts() public {
        _depositAndSettle(alice, HUNDRED_USDC, 0);

        vm.prank(alice);
        vm.expectRevert("Vault4: not manager");
        vault.sweepToL1(50 * ONE_USDC);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Record L1 Return
    // ═══════════════════════════════════════════════════════════════════

    function test_recordL1Return() public {
        _depositAndSettle(alice, HUNDRED_USDC, 0);

        vm.prank(manager);
        vault.sweepToL1(50 * ONE_USDC);
        assertEq(vault.deployedToL1(), 50 * ONE_USDC);

        // Simulate USDC arriving back at contract
        usdc.mint(address(vault), 50 * ONE_USDC);

        vm.prank(manager);
        vault.recordL1Return(50 * ONE_USDC);
        assertEq(vault.deployedToL1(), 0);
    }

    function test_recordL1Return_exceedsDeployed_reverts() public {
        vm.prank(manager);
        vm.expectRevert("Vault4: exceeds deployed");
        vault.recordL1Return(100 * ONE_USDC);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Stale NAV Guard
    // ═══════════════════════════════════════════════════════════════════

    function test_settle_staleNAV_reverts() public {
        vm.prank(alice);
        vault.requestDeposit(HUNDRED_USDC);
        vm.warp(block.timestamp + 1);

        // Manager updates NAV
        vm.prank(manager);
        vault.updateTotalAssets(0);

        // Fast-forward beyond MAX_NAV_AGE (1 hour)
        vm.warp(block.timestamp + 2 hours);

        // Settle should fail due to stale NAV
        vm.prank(manager);
        vm.expectRevert("Vault4: stale NAV");
        vault.settle(100, 100);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Pause
    // ═══════════════════════════════════════════════════════════════════

    function test_pause_blocksDeposits() public {
        vm.prank(manager);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert();
        vault.requestDeposit(HUNDRED_USDC);
    }

    function test_pause_blocksWithdraws() public {
        _depositAndSettle(alice, HUNDRED_USDC, 0);

        vm.prank(manager);
        vault.pause();

        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert();
        vault.requestWithdraw(shares);
    }

    function test_unpause_allowsDeposits() public {
        vm.prank(manager);
        vault.pause();

        vm.prank(manager);
        vault.unpause();

        vm.prank(alice);
        vault.requestDeposit(HUNDRED_USDC);
        assertEq(vault.depositQueueLength(), 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Manager Transfer
    // ═══════════════════════════════════════════════════════════════════

    function test_managerTransfer_twoStep() public {
        address newManager = makeAddr("newManager");

        vm.prank(manager);
        vault.transferManager(newManager);
        assertEq(vault.pendingManager(), newManager);
        assertEq(vault.manager(), manager); // still old manager

        vm.prank(newManager);
        vault.acceptManager();
        assertEq(vault.manager(), newManager);
        assertEq(vault.pendingManager(), address(0));
    }

    function test_acceptManager_notPending_reverts() public {
        vm.prank(alice);
        vm.expectRevert("Vault4: not pending manager");
        vault.acceptManager();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Share Price View
    // ═══════════════════════════════════════════════════════════════════

    function test_sharePrice_initial() public view {
        // No supply, price = 1.0 (PRECISION)
        assertEq(vault.sharePrice(), NAVLib.PRECISION);
    }

    function test_sharePrice_afterDeposit() public {
        _depositAndSettle(alice, HUNDRED_USDC, 0);
        // Price should be ~1.0
        assertApproxEqRel(vault.sharePrice(), NAVLib.PRECISION, 0.01e18);
    }

    function test_sharePrice_afterProfit() public {
        _depositAndSettle(alice, THOUSAND_USDC, 0);

        // NAV grows 20%
        vm.prank(manager);
        vault.updateTotalAssets(1200 * ONE_USDC);

        // Price should be ~1.2
        uint256 expectedPrice = (1200 * NAVLib.PRECISION) / 1000;
        assertApproxEqRel(vault.sharePrice(), expectedPrice, 0.01e18);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Share Transferability
    // ═══════════════════════════════════════════════════════════════════

    function test_sharesTransferable() public {
        _depositAndSettle(alice, HUNDRED_USDC, 0);

        uint256 aliceShares = vault.balanceOf(alice);
        uint256 half = aliceShares / 2;

        vm.prank(alice);
        vault.transfer(bob, half);

        assertEq(vault.balanceOf(bob), half);
        assertEq(vault.balanceOf(alice), aliceShares - half);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  NAVLib Unit Tests
    // ═══════════════════════════════════════════════════════════════════

    function test_NAVLib_computeSharePrice_zeroSupply() public pure {
        assertEq(NAVLib.computeSharePrice(100e6, 0), NAVLib.PRECISION);
    }

    function test_NAVLib_computeSharePrice_normal() public pure {
        uint256 price = NAVLib.computeSharePrice(200e6, 100e6);
        assertEq(price, 2 * NAVLib.PRECISION);
    }

    function test_NAVLib_performanceFee_noProfit() public pure {
        (uint256 fee, uint256 hwm) =
            NAVLib.computePerformanceFee(NAVLib.PRECISION, NAVLib.PRECISION, 100e6, 1000);
        assertEq(fee, 0);
        assertEq(hwm, NAVLib.PRECISION);
    }

    function test_NAVLib_performanceFee_withProfit() public pure {
        uint256 currentPrice = 1.1e18; // 10% profit
        uint256 hwm = 1e18;
        uint256 supply = 1000e6; // 1000 shares

        (uint256 fee, uint256 newHWM) =
            NAVLib.computePerformanceFee(currentPrice, hwm, supply, 1000);

        // Profit = 0.1 * 1000 shares = 100 USDC, fee = 10%  = 10 USDC
        assertEq(fee, 10e6);
        assertEq(newHWM, currentPrice);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Full Round Trip
    // ═══════════════════════════════════════════════════════════════════

    function test_fullRoundTrip() public {
        // 1. Alice deposits 1000 USDC
        vm.prank(alice);
        vault.requestDeposit(THOUSAND_USDC);
        vm.warp(block.timestamp + 1);

        vm.startPrank(manager);
        vault.updateTotalAssets(0);
        vault.settle(100, 100);

        // 2. Manager sweeps 800 USDC to L1
        vault.sweepToL1(800 * ONE_USDC);
        assertEq(vault.deployedToL1(), 800 * ONE_USDC);

        // 3. L1 investments grow to 960 USDC (20% profit on 800)
        //    Total NAV = 200 (idle) + 960 (L1) = 1160
        vm.warp(block.timestamp + 2 days);

        // 4. Manager returns 460 USDC from L1
        usdc.mint(address(vault), 460 * ONE_USDC);
        vault.recordL1Return(460 * ONE_USDC);
        // deployedToL1 = 800 - 460 = 340
        // idle = 200 + 460 = 660

        // 5. Bob deposits 500 USDC
        vm.stopPrank();
        vm.prank(bob);
        vault.requestDeposit(500 * ONE_USDC);
        vm.warp(block.timestamp + 1);

        // 6. Alice requests partial withdrawal (half her shares)
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.requestWithdraw(aliceShares / 2);
        vm.warp(block.timestamp + 1);

        // 7. Settle at NAV = 1160 USDC
        vm.startPrank(manager);
        vault.updateTotalAssets(1160 * ONE_USDC);
        vault.settle(100, 100);
        vm.stopPrank();

        // 8. Verify outcomes
        assertGt(vault.balanceOf(bob), 0, "Bob has shares");
        assertGt(vault.balanceOf(alice), 0, "Alice still has some shares");
        assertGt(vault.balanceOf(manager), 0, "Manager got fee shares");
        assertEq(vault.epoch(), 2);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Helper: deposit and immediately settle for an investor
    function _depositAndSettle(
        address investor,
        uint256 assets,
        uint256 navBeforeDeposit
    ) internal {
        vm.prank(investor);
        vault.requestDeposit(assets);
        vm.warp(block.timestamp + 1);

        vm.startPrank(manager);
        vault.updateTotalAssets(navBeforeDeposit);
        vault.settle(100, 100);
        vm.stopPrank();
    }
}
