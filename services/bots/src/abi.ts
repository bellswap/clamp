// Minimal ABIs the bots call, from contracts/src (TicketBook.sol, HouseVault.sol); errors included so viem decodes
// revert names for the stats line.
import { parseAbi } from 'viem';

export const BOOK = parseAbi([
  'function open(bytes32 symbol, bool long, uint8 leverage, uint256 stake, uint8 horizon) returns (uint256 id)',
  'function markets(bytes32 symbol) view returns (address ref, uint8 maxLeverage, bool listed, uint64 maxStaleness, uint256 maxStake, uint256 oiCap, uint256 oi)',
  'function ticketCount() view returns (uint256)',
  'struct Ticket { address owner; bytes32 symbol; bool long; uint8 leverage; uint8 horizon; uint256 stake; uint256 entryPrice8; uint64 openedAt; uint64 expiry; uint256 reserved; uint8 status; uint256 payout; uint256 settlePrice8; }',
  'function getTicket(uint256 id) view returns (Ticket)',
  'function paused() view returns (bool)',
  'event TicketOpened(uint256 indexed id, address indexed owner, bytes32 indexed symbol, bool long, uint8 leverage, uint256 stake, uint256 entryPrice8, uint64 expiry)',
  'error NotListed(bytes32 symbol)',
  'error BadLeverage(uint8 leverage, uint8 maxLeverage)',
  'error BadStake(uint256 stake, uint256 maxStake)',
  'error BadHorizon(uint8 horizon)',
  'error Stale(uint64 timestamp, uint64 maxStaleness)',
  'error OiCap(uint256 oi, uint256 oiCap)',
  'error ZeroNetStake()',
  'error EnforcedPause()',
  'error InsufficientFree(uint256 amount, uint256 free)',
  'error NoRound(bytes32 symbol)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error SafeERC20FailedOperation(address token)',
]);

export const VAULT = parseAbi([
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)',
  'function totalAssets() view returns (uint256)',
  'function free() view returns (uint256)',
  'function reserved() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function maxWithdraw(address owner) view returns (uint256)',
  'error InsufficientFree(uint256 amount, uint256 free)',
  'error ZeroShares()',
  'error ERC4626ExceededMaxWithdraw(address owner, uint256 assets, uint256 max)',
  'error ERC4626ExceededMaxDeposit(address receiver, uint256 assets, uint256 max)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error SafeERC20FailedOperation(address token)',
]);

export const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
