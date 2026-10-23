// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IReference} from "./interfaces/IReference.sol";
import {HouseVault} from "./HouseVault.sol";

/// @title TicketBook
/// @notice Capped lever tickets on a reference price against the HouseVault. A ticket picks a listed symbol, a side,
/// a multiple L (1 to the market's max, at most 20), a stake in USDG and a horizon. Payout at settlement is
///   net stake * clamp(1 + L * r, 0, L),  r = (settle - entry) / entry, sign flipped for a short,
/// computed in 1e18 fixed point and rounded down (the house side of every rounding). The loss is at most the stake;
/// there is no liquidation. Not upgradeable. The fee stays in the vault: the whole stake is collected into the vault
/// and the book never sends USDG anywhere but the vault and the ticket owner.
///
/// Buckets: tickets of one symbol and one expiry (a bucket) settle at one price (the first settlement fixes it for
/// the bucket). The vault reserves every ticket's full cap, the bucket bound is M_l + M_s (M = sum of net stake * L
/// per side), because tickets of one bucket open at different entry prices and an opposite-side netting bound that
/// ignores the entries under-reserves (entry-aware netting is future work). After the bucket price
/// is fixed, each payout comes out of the bucket's reservation and the rest is cut to min(left, bound of the open
/// tickets). The vault also tracks the summed net stake of open tickets (`openNet`) so LP shares are priced net of it.
///
/// Horizons: 0 session (next 21:00 UTC on the chain clock), 1 day (now + 24 h, rounded up to the next full hour so
/// tickets share buckets), 2 week (now + 7 d, rounded up the same way).
contract TicketBook is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Ticket {
        address owner;
        bytes32 symbol;
        bool long;
        uint8 leverage;
        uint8 horizon;
        uint256 stake; // gross stake in USDG (6 decimals), fee included
        uint256 entryPrice8;
        uint64 openedAt;
        uint64 expiry;
        uint256 reserved; // worst-case payout, net stake * leverage (the net stake is reserved / leverage)
        uint8 status;
        uint256 payout;
        uint256 settlePrice8;
    }

    struct Market {
        IReference ref;
        uint8 maxLeverage;
        bool listed;
        uint64 maxStaleness;
        uint256 maxStake;
        uint256 oiCap;
        uint256 oi; // sum of gross stakes of open tickets
    }

    struct Bucket {
        IReference ref;
        uint32 open;
        bool priced;
        uint64 settleTimestamp;
        uint256 settlePrice8;
        uint256 longNet;
        uint256 longMax;
        uint256 shortNet;
        uint256 shortMax;
        uint256 reserved;
    }

    uint8 public constant STATUS_OPEN = 1;
    uint8 public constant STATUS_SETTLED = 2;
    uint8 public constant HORIZON_SESSION = 0;
    uint8 public constant HORIZON_DAY = 1;
    uint8 public constant HORIZON_WEEK = 2;
    uint8 public constant MAX_LEVERAGE = 20;
    uint16 public constant MAX_FEE_BPS = 1000;
    uint256 public constant WAD = 1e18;
    uint64 public constant SESSION_CLOSE = 21 hours;

    IERC20 public immutable usdg;
    HouseVault public immutable vault;
    uint16 public feeBps;

    uint256 public ticketCount;
    mapping(uint256 id => Ticket) internal _tickets;
    mapping(bytes32 symbol => Market) public markets;
    mapping(bytes32 key => Bucket) public buckets;
    bytes32[] internal _symbols;

    event MarketListed(
        bytes32 indexed symbol,
        address referenceAddress,
        uint8 maxLeverage,
        uint256 maxStake,
        uint256 oiCap,
        uint64 maxStaleness
    );
    event TicketOpened(
        uint256 indexed id,
        address indexed owner,
        bytes32 indexed symbol,
        bool long,
        uint8 leverage,
        uint256 stake,
        uint256 entryPrice8,
        uint64 expiry
    );
    event TicketSettled(uint256 indexed id, uint256 settlePrice8, uint256 payout);
    event Reserved(bytes32 indexed bucket, bytes32 indexed symbol, uint64 expiry, uint256 amount);
    event Released(bytes32 indexed bucket, bytes32 indexed symbol, uint64 expiry, uint256 amount);
    event BucketPriced(bytes32 indexed bucket, bytes32 indexed symbol, uint64 expiry, uint256 price8, uint64 timestamp);
    event FeeSet(uint16 feeBps);

    error AssetMismatch();
    error ZeroAddress();
    error ZeroSymbol();
    error BadMaxLeverage(uint8 maxLeverage);
    error FeeTooHigh(uint16 feeBps);
    error NotListed(bytes32 symbol);
    error BadLeverage(uint8 leverage, uint8 maxLeverage);
    error BadStake(uint256 stake, uint256 maxStake);
    error BadHorizon(uint8 horizon);
    error Stale(uint64 timestamp, uint64 maxStaleness);
    error OiCap(uint256 oi, uint256 oiCap);
    error ZeroNetStake();
    error NotOpen(uint256 id);
    error NotExpired(uint256 id, uint64 expiry);
    error EarlyPrice(uint64 timestamp, uint64 expiry);
    error ReserveInvariant(uint256 payout, uint256 bucketReserved);

    constructor(IERC20 usdg_, HouseVault vault_, address owner_, uint16 feeBps_) Ownable(owner_) {
        if (address(usdg_) == address(0) || address(vault_) == address(0)) revert ZeroAddress();
        if (vault_.asset() != address(usdg_)) revert AssetMismatch();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        usdg = usdg_;
        vault = vault_;
        feeBps = feeBps_;
        usdg_.forceApprove(address(vault_), type(uint256).max);
        emit FeeSet(feeBps_);
    }

    // ------------------------------------------------------------------ owner

    /// @notice Lists `symbol` or updates its parameters. Open interest is kept on an update; buckets keep the
    /// reference they were opened with.
    function listMarket(
        bytes32 symbol,
        address referenceAddress,
        uint8 maxLeverage,
        uint256 maxStake,
        uint256 oiCap,
        uint64 maxStaleness
    ) external onlyOwner {
        if (symbol == bytes32(0)) revert ZeroSymbol();
        if (referenceAddress == address(0)) revert ZeroAddress();
        if (maxLeverage == 0 || maxLeverage > MAX_LEVERAGE) revert BadMaxLeverage(maxLeverage);
        Market storage m = markets[symbol];
        if (!m.listed) {
            m.listed = true;
            _symbols.push(symbol);
        }
        m.ref = IReference(referenceAddress);
        m.maxLeverage = maxLeverage;
        m.maxStake = maxStake;
        m.oiCap = oiCap;
        m.maxStaleness = maxStaleness;
        emit MarketListed(symbol, referenceAddress, maxLeverage, maxStake, oiCap, maxStaleness);
    }

    function setFee(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    /// @notice Stops new tickets. Settlement stays open while paused.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------ tickets

    /// @notice Opens a ticket. Approve `stake` USDG to this book first.
    function open(bytes32 symbol, bool long, uint8 leverage, uint256 stake, uint8 horizon)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 id)
    {
        Market storage m = markets[symbol];
        uint256 entry = _checkOpen(m, symbol, leverage, stake);
        uint64 expiry = expiryFor(horizon, uint64(block.timestamp));

        uint256 net = stake - stake * feeBps / 10_000; // the fee rounds down
        if (net == 0) revert ZeroNetStake();
        uint256 worst = net * leverage;
        m.oi += stake;

        usdg.safeTransferFrom(msg.sender, address(this), stake);
        vault.collect(address(this), stake);
        vault.addOpenNet(net);
        _book(m, symbol, expiry, long, net, worst);

        id = ++ticketCount;
        _tickets[id] = Ticket({
            owner: msg.sender,
            symbol: symbol,
            long: long,
            leverage: leverage,
            horizon: horizon,
            stake: stake,
            entryPrice8: entry,
            openedAt: uint64(block.timestamp),
            expiry: expiry,
            reserved: worst,
            status: STATUS_OPEN,
            payout: 0,
            settlePrice8: 0
        });
        emit TicketOpened(id, msg.sender, symbol, long, leverage, stake, entry, expiry);
    }

    /// @notice Settles ticket `id` at or after its expiry. Permissionless. `proof` goes to the reference on the
    /// first settlement of the ticket's bucket and is ignored afterwards.
    function settle(uint256 id, bytes calldata proof) external nonReentrant returns (uint256 payout) {
        Ticket storage t = _tickets[id];
        if (t.status != STATUS_OPEN) revert NotOpen(id);
        if (block.timestamp < t.expiry) revert NotExpired(id, t.expiry);

        bytes32 key = bucketKey(t.symbol, t.expiry);
        Bucket storage b = buckets[key];
        if (!b.priced) {
            (uint256 p, uint64 ts) = b.ref.priceAtOrAfter(t.symbol, t.expiry, proof);
            if (ts < t.expiry) revert EarlyPrice(ts, t.expiry);
            b.priced = true;
            b.settlePrice8 = p;
            b.settleTimestamp = ts;
            emit BucketPriced(key, t.symbol, t.expiry, p, ts);
        }
        uint256 price = b.settlePrice8;
        uint256 net = t.reserved / t.leverage;
        payout = payoutFor(t.long, t.leverage, net, t.entryPrice8, price);

        if (t.long) {
            b.longNet -= net;
            b.longMax -= t.reserved;
        } else {
            b.shortNet -= net;
            b.shortMax -= t.reserved;
        }
        b.open -= 1;
        markets[t.symbol].oi -= t.stake;

        if (payout > b.reserved) revert ReserveInvariant(payout, b.reserved);
        uint256 left = b.reserved - payout;
        uint256 target = Math.min(left, _bound(b));
        b.reserved = target;
        uint256 rel = payout + (left - target);

        t.status = STATUS_SETTLED;
        t.payout = payout;
        t.settlePrice8 = price;

        vault.subOpenNet(net);
        if (rel > 0) vault.release(rel);
        if (payout > 0) vault.pay(t.owner, payout);
        emit Released(key, t.symbol, t.expiry, rel);
        emit TicketSettled(id, price, payout);
    }

    function _checkOpen(Market storage m, bytes32 symbol, uint8 leverage, uint256 stake)
        internal
        view
        returns (uint256 entry)
    {
        if (!m.listed) revert NotListed(symbol);
        if (leverage == 0 || leverage > m.maxLeverage) revert BadLeverage(leverage, m.maxLeverage);
        if (stake == 0 || stake > m.maxStake) revert BadStake(stake, m.maxStake);
        if (m.oi + stake > m.oiCap) revert OiCap(m.oi + stake, m.oiCap);
        uint64 ts;
        (entry, ts,) = m.ref.latest(symbol);
        if (ts < block.timestamp && block.timestamp - ts > m.maxStaleness) revert Stale(ts, m.maxStaleness);
    }

    /// @dev Adds a ticket to its bucket and reserves the increase of the bucket bound in the vault.
    function _book(Market storage m, bytes32 symbol, uint64 expiry, bool long, uint256 net, uint256 worst) internal {
        bytes32 key = bucketKey(symbol, expiry);
        Bucket storage b = buckets[key];
        if (address(b.ref) == address(0)) b.ref = m.ref;
        uint256 before = b.reserved;
        if (long) {
            b.longNet += net;
            b.longMax += worst;
        } else {
            b.shortNet += net;
            b.shortMax += worst;
        }
        b.open += 1;
        uint256 need = _bound(b);
        b.reserved = need;
        uint256 inc = need - before;
        if (inc > 0) vault.reserve(inc);
        emit Reserved(key, symbol, expiry, inc);
    }

    // ------------------------------------------------------------------ math

    /// @notice The payout multiplier clamp(1 + L * r, 0, L) in 1e18 fixed point, r signed by side. Rounds down:
    /// a gain is floored, a loss is ceiled.
    function multiplierFor(bool long, uint8 leverage, uint256 entry8, uint256 settle8) public pure returns (uint256) {
        uint256 cap = uint256(leverage) * WAD;
        bool up = settle8 >= entry8;
        uint256 diff = up ? settle8 - entry8 : entry8 - settle8;
        bool gain = (up == long) || diff == 0;
        if (gain) {
            uint256 g = Math.mulDiv(diff, cap, entry8, Math.Rounding.Floor);
            uint256 m = WAD + g;
            return m > cap ? cap : m;
        }
        uint256 loss = Math.mulDiv(diff, cap, entry8, Math.Rounding.Ceil);
        return loss >= WAD ? 0 : WAD - loss;
    }

    /// @notice Payout of a ticket with net stake `net`: net * multiplier / 1e18, rounded down.
    function payoutFor(bool long, uint8 leverage, uint256 net, uint256 entry8, uint256 settle8)
        public
        pure
        returns (uint256)
    {
        return Math.mulDiv(net, multiplierFor(long, leverage, entry8, settle8), WAD);
    }

    /// @notice Expiry of a ticket opened at `nowTs` with `horizon`.
    function expiryFor(uint8 horizon, uint64 nowTs) public pure returns (uint64) {
        if (horizon == HORIZON_SESSION) {
            uint64 e = nowTs - (nowTs % 1 days) + SESSION_CLOSE;
            return e > nowTs ? e : e + 1 days;
        }
        if (horizon == HORIZON_DAY) return _ceilHour(nowTs + 1 days);
        if (horizon == HORIZON_WEEK) return _ceilHour(nowTs + 7 days);
        revert BadHorizon(horizon);
    }

    function bucketKey(bytes32 symbol, uint64 expiry) public pure returns (bytes32) {
        return keccak256(abi.encode(symbol, expiry));
    }

    function _ceilHour(uint64 x) internal pure returns (uint64) {
        return (x + 1 hours - 1) / 1 hours * 1 hours;
    }

    /// @dev Worst-case total payout of a bucket: every ticket's cap, M_l + M_s. Each payout is at most net * L, so
    /// a settlement never exceeds the bucket's reservation, whatever the entry prices.
    function _bound(Bucket storage b) internal view returns (uint256) {
        return b.longMax + b.shortMax;
    }

    // ------------------------------------------------------------------ views

    function getTicket(uint256 id) external view returns (Ticket memory) {
        return _tickets[id];
    }

    /// @notice Net stake of ticket `id` (stake minus fee).
    function netStake(uint256 id) external view returns (uint256) {
        Ticket storage t = _tickets[id];
        return t.leverage == 0 ? 0 : t.reserved / t.leverage;
    }

    /// @notice Payout of an open ticket if it settled at the reference's latest price (for the watch view).
    function currentPayout(uint256 id) external view returns (uint256 payout, uint256 price8, uint64 timestamp) {
        Ticket storage t = _tickets[id];
        if (t.status != STATUS_OPEN) revert NotOpen(id);
        IReference ref = buckets[bucketKey(t.symbol, t.expiry)].ref;
        (price8, timestamp,) = ref.latest(t.symbol);
        payout = payoutFor(t.long, t.leverage, t.reserved / t.leverage, t.entryPrice8, price8);
    }

    /// @notice Fee, net stake, max payout and expiry of a ticket opened now with these inputs.
    function quote(uint8 leverage, uint256 stake, uint8 horizon)
        external
        view
        returns (uint256 fee, uint256 net, uint256 maxPayout, uint64 expiry)
    {
        fee = stake * feeBps / 10_000;
        net = stake - fee;
        maxPayout = net * leverage;
        expiry = expiryFor(horizon, uint64(block.timestamp));
    }

    function listedSymbols() external view returns (bytes32[] memory) {
        return _symbols;
    }

    /// @notice The vault reservation a bucket needs right now (its stored reservation).
    function bucketReserved(bytes32 symbol, uint64 expiry) external view returns (uint256) {
        return buckets[bucketKey(symbol, expiry)].reserved;
    }
}
