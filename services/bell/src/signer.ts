// Demo signer rounds: the digest DemoSignerReference recovers (contracts/src/references/DemoSignerReference.sol):
//   digest = keccak256(abi.encode(DOMAIN_TAG, block.chainid, address(this), symbol, price8, timestamp))
//   DOMAIN_TAG = keccak256("bellswap.v2.DemoSignerReference.post")
//   signature = EIP-191 personal sign over the 32-byte digest (MessageHashUtils.toEthSignedMessageHash, ECDSA)
import { encodeAbiParameters, keccak256, toHex, type Account, type Address, type Hex } from 'viem';

export const DOMAIN_TAG: Hex = keccak256(toHex('bellswap.v2.DemoSignerReference.post'));

export function roundDigest(chainId: number, reference: Address, symbol: Hex, price8: bigint, timestamp: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint64' }],
      [DOMAIN_TAG, BigInt(chainId), reference, symbol, price8, BigInt(timestamp)],
    ),
  );
}

export async function signRound(account: Account, chainId: number, reference: Address, symbol: Hex, price8: bigint, timestamp: number): Promise<Hex> {
  if (!account.signMessage) throw new Error('signer account cannot sign');
  return account.signMessage({ message: { raw: roundDigest(chainId, reference, symbol, price8, timestamp) } });
}
