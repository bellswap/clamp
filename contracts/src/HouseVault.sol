// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HouseVault
/// @notice The house: one ERC-4626 vault on USDG (6 decimals). Every open ticket's worst case is booked here as
/// `reserved`; LPs can only take out `free()` = USDG balance - reserved. Only the TicketBook (bound once by the
/// owner) may reserve, release, pay, collect and track open stakes. Shares are priced on totalAssets = USDG balance
/// minus `openNet` (the summed net stakes of open tickets), which values every open ticket at an unchanged price, so
/// an LP cannot redeem against stakes the house still owes back. Shares carry 12 decimals (a decimals offset of 6
/// against donation attacks), and a deposit or mint that would produce zero shares reverts.
contract HouseVault is ERC4626, Ownable {
    using SafeERC20 for IERC20;

    address public book;
    uint256 public reserved;
    /// @notice Summed net stakes of open tickets: what the vault owes them if the price does not move.
    uint256 public openNet;

    event BookSet(address indexed book);
    event Reserved(uint256 amount, uint256 totalReserved);
    event Released(uint256 amount, uint256 totalReserved);
    event Paid(address indexed to, uint256 amount);
    event Collected(address indexed from, uint256 amount);

    error OnlyBook();
    error BookAlreadySet();
    error ZeroAddress();
    error InsufficientFree(uint256 amount, uint256 free);
    error ReleaseExceedsReserved(uint256 amount, uint256 reserved);
    error PayBreaksReserve(uint256 amount, uint256 free);
    error OpenNetUnderflow(uint256 amount, uint256 openNet);
    error ZeroShares();

    modifier onlyBook() {
        if (msg.sender != book) revert OnlyBook();
        _;
    }

    constructor(IERC20 usdg, address owner_)
        ERC20("Bellswap House Vault", "bsHOUSE")
        ERC4626(usdg)
        Ownable(owner_)
    {}

    /// @notice Binds the TicketBook. One time only.
    function setBook(address book_) external onlyOwner {
        if (book != address(0)) revert BookAlreadySet();
        if (book_ == address(0)) revert ZeroAddress();
        book = book_;
        emit BookSet(book_);
    }

    /// @notice Share value base: the USDG balance minus the net stakes of open tickets (0 when below).
    function totalAssets() public view override returns (uint256) {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        return bal > openNet ? bal - openNet : 0;
    }

    /// @notice Liquidity not booked against open tickets: USDG balance minus reserved (0 when below).
    function free() public view returns (uint256) {
        uint256 a = IERC20(asset()).balanceOf(address(this));
        return a > reserved ? a - reserved : 0;
    }

    /// @notice The book adds a ticket's net stake when it opens.
    function addOpenNet(uint256 amount) external onlyBook {
        openNet += amount;
    }

    /// @notice The book removes a ticket's net stake when it settles.
    function subOpenNet(uint256 amount) external onlyBook {
        if (amount > openNet) revert OpenNetUnderflow(amount, openNet);
        openNet -= amount;
    }

    function reserve(uint256 amount) external onlyBook {
        uint256 f = free();
        if (amount > f) revert InsufficientFree(amount, f);
        reserved += amount;
        emit Reserved(amount, reserved);
    }

    function release(uint256 amount) external onlyBook {
        if (amount > reserved) revert ReleaseExceedsReserved(amount, reserved);
        reserved -= amount;
        emit Released(amount, reserved);
    }

    /// @notice Pays `amount` out of free liquidity. The book releases a ticket's share of the reservation first.
    function pay(address to, uint256 amount) external onlyBook {
        uint256 f = free();
        if (amount > f) revert PayBreaksReserve(amount, f);
        IERC20(asset()).safeTransfer(to, amount);
        emit Paid(to, amount);
    }

    /// @notice Pulls `amount` USDG from `from` (which approved this vault) into the vault.
    function collect(address from, uint256 amount) external onlyBook {
        IERC20(asset()).safeTransferFrom(from, address(this), amount);
        emit Collected(from, amount);
    }

    /// @dev Virtual shares and assets against donation (inflation) attacks; shares have 6 + 6 = 12 decimals.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @dev Covers deposit and mint: a deposit that rounds to zero shares reverts instead of donating.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (shares == 0) revert ZeroShares();
        super._deposit(caller, receiver, assets, shares);
    }

    /// @dev Withdrawals are capped by free liquidity.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        uint256 m = super.maxWithdraw(owner_);
        uint256 f = free();
        return m < f ? m : f;
    }

    /// @dev Redemptions are capped by the shares that free liquidity buys back (rounded down).
    function maxRedeem(address owner_) public view override returns (uint256) {
        uint256 m = super.maxRedeem(owner_);
        uint256 f = convertToShares(free());
        return m < f ? m : f;
    }
}
