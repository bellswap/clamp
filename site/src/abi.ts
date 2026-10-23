// ABIs of the playground contracts. bookAbi and vaultAbi are generated from contracts/out by scripts/abi.ts
// (src/abi/<Name>.ts); rerun it after any contracts change. erc20Abi covers the three USDG calls the site makes.
import { parseAbi } from 'viem';
import TicketBookAbi from './abi/TicketBook';
import HouseVaultAbi from './abi/HouseVault';
import DemoSignerReferenceAbi from './abi/DemoSignerReference';

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export const bookAbi = TicketBookAbi;
export const vaultAbi = HouseVaultAbi;
export const referenceAbi = DemoSignerReferenceAbi;
