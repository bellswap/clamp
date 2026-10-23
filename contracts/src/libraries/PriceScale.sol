// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title PriceScale
/// @notice Converts prices between decimal scales. Every Bellswap price carries 8 decimals.
/// Rounding: scaling down truncates (rounds toward zero); scaling up is exact.
library PriceScale {
    error NonPositivePrice();
    error ScaleOutOfRange();

    uint8 internal constant PRICE_DECIMALS = 8;

    /// @notice A positive `answer` with `decimals` decimals as an 8-decimal price.
    function to8(int256 answer, uint8 decimals) internal pure returns (uint256) {
        if (answer <= 0) revert NonPositivePrice();
        // answer > 0 is checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 a = uint256(answer);
        if (decimals == PRICE_DECIMALS) return a;
        if (decimals > PRICE_DECIMALS) {
            uint8 d = decimals - PRICE_DECIMALS;
            if (d > 59) revert ScaleOutOfRange();
            return a / (10 ** d);
        }
        return a * (10 ** (PRICE_DECIMALS - decimals));
    }

    /// @notice A Pyth price `price * 10^expo` as an 8-decimal price.
    function pythTo8(int64 price, int32 expo) internal pure returns (uint256) {
        if (price <= 0) revert NonPositivePrice();
        // price > 0 is checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 a = uint256(uint64(price));
        int256 shift = int256(expo) + int256(uint256(PRICE_DECIMALS));
        if (shift == 0) return a;
        if (shift > 0) {
            if (shift > 59) revert ScaleOutOfRange();
            // shift is in (0, 59]
            // forge-lint: disable-next-line(unsafe-typecast)
            return a * (10 ** uint256(shift));
        }
        if (-shift > 59) revert ScaleOutOfRange();
        // -shift is in (0, 59]
        // forge-lint: disable-next-line(unsafe-typecast)
        return a / (10 ** uint256(-shift));
    }
}
