// Playground chain and service config, read from the build environment.
import { defineChain } from 'viem';

export const CHAIN_ID = 46633;
export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? 'http://127.0.0.1:8545';
export const BELL_URL: string = import.meta.env.VITE_BELL_URL ?? 'http://127.0.0.1:8787';
/** VITE_MOCK=1: the app runs on fixture data (src/lib/mock.ts), no RPC and no bell needed. */
export const MOCK: boolean = import.meta.env.VITE_MOCK === '1' || import.meta.env.VITE_MOCK === 'true';

/** Contract addresses from deployments/book.json, passed in as VITE_BOOK_JSON; empty until the deploy script ran. */
export interface Book { usdg?: string; vault?: string; book?: string; reference?: string; feeBps?: number }
export const BOOK: Book = (() => {
  try {
    return JSON.parse(import.meta.env.VITE_BOOK_JSON ?? '{}') as Book;
  } catch {
    return {};
  }
})();

/** Ticket fee in basis points of the stake, to the vault. The contract's feeBps() wins when the book answers it. */
export const FEE_BPS_DEFAULT: number = typeof BOOK.feeBps === 'number' ? BOOK.feeBps : 100;
export const USDG_DECIMALS = 6;
export const PRICE_DECIMALS = 8;

export const playChain = defineChain({
  id: CHAIN_ID,
  name: 'Bellswap Playground',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  testnet: true,
});
