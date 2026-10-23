// Writes test/fixtures/logs.json: TicketBook and HouseVault logs encoded with the minimal ABI. bun run scripts/make-fixture.ts > test/fixtures/logs.json
import { encodeAbiParameters, encodeEventTopics, numberToHex, stringToHex } from 'viem';
import { MIN_HOUSE_VAULT, MIN_TICKET_BOOK } from '../src/abi';
const book = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const vault = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const owner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const sym = stringToHex('NVDA', { size: 32 });
const ev = (abi: any, name: string, args: any, types: any[], vals: any[], address: string, block: number, li: number) => ({
  address, topics: encodeEventTopics({ abi, eventName: name, args } as any), data: encodeAbiParameters(types, vals),
  blockNumber: numberToHex(block), blockHash: null, transactionHash: '0x' + (block * 100 + li).toString(16).padStart(64, '0'), logIndex: numberToHex(li),
});
const logs = [
  ev(MIN_TICKET_BOOK, 'MarketListed', { symbol: sym }, [{ type: 'address' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }], ['0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', 20, 10_000_000_000n, 1_000_000_000_000n, 600n], book, 10, 0),
  ev(MIN_HOUSE_VAULT, 'Deposit', { sender: owner, owner }, [{ type: 'uint256' }, { type: 'uint256' }], [500_000_000_000n, 500_000_000_000n], vault, 11, 0),
  ev(MIN_TICKET_BOOK, 'TicketOpened', { id: 1n, owner, symbol: sym }, [{ type: 'bool' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }], [false, 5, 100_000_000n, 18_000_000_000n, 1792364400n], book, 12, 3),
  ev(MIN_TICKET_BOOK, 'TicketSettled', { id: 1n }, [{ type: 'uint256' }, { type: 'uint256' }], [17_640_000_000n, 108_900_000n], book, 20, 1),
];
console.log(JSON.stringify(logs, null, 2));
