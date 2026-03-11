// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title NAVLib — Pure math for NAV and performance fee calculations
library NAVLib {
    uint256 internal constant PRECISION = 1e18;

    /// @notice Compute share price from total assets and total shares
    /// @return pricePerShare in 18-decimal precision (1e18 = 1 USDC per share)
    function computeSharePrice(
        uint256 totalAssets,
        uint256 totalShares
    ) internal pure returns (uint256) {
        if (totalShares == 0) return PRECISION;
        return (totalAssets * PRECISION) / totalShares;
    }

    /// @notice Compute performance fee based on high-water mark
    /// @param currentPricePerShare Current share price (18 dec)
    /// @param highWaterMark Previous peak share price (18 dec)
    /// @param totalShares Current share supply
    /// @param feeBps Fee in basis points (e.g. 1000 = 10%)
    /// @return feeAssets USDC amount owed as fee (6 dec)
    /// @return newHWM Updated high-water mark (18 dec)
    function computePerformanceFee(
        uint256 currentPricePerShare,
        uint256 highWaterMark,
        uint256 totalShares,
        uint256 feeBps
    ) internal pure returns (uint256 feeAssets, uint256 newHWM) {
        if (currentPricePerShare <= highWaterMark || totalShares == 0) {
            return (0, highWaterMark);
        }

        uint256 profitPerShare = currentPricePerShare - highWaterMark;
        uint256 totalProfit = (profitPerShare * totalShares) / PRECISION;
        feeAssets = (totalProfit * feeBps) / 10_000;
        newHWM = currentPricePerShare;
    }
}
