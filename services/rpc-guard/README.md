# rpc-guard

JSON-RPC proxy between eRPC and anvil (`erpc -> rpc-guard:8546 -> anvil:8545`). The bell and the bots talk to
anvil directly and never pass through it.

Rejected with JSON-RPC error `-32003` and a plain message, never forwarded:

- `eth_sendRawTransaction` and every `eth_sendRaw*` variant, unless it is a plain call into the playground's own
  contracts: the recovered sender is not one of the anvil dev keys 0 to 9 (derived from the public anvil mnemonic),
  `to` is one of the targets (TicketBook, HouseVault, USDG), the calldata does not contain a reference address, and
  there is no EIP-7702 authorization list. Contract creation is rejected, so a relay that rebuilds the reference
  address at run time cannot be deployed, and no other deployed contract can be called. Undecodable raw transactions
  are rejected too. While no target is known every raw send is rejected (fail closed);
- every other `eth_send*` method (`eth_sendTransaction`, `eth_sendTransactionSync`, `eth_sendUnsignedTransaction`),
  `eth_sign*` (`eth_signTransaction` included), `wallet_*`, `odyssey_*`, `anvil_*`, `evm_*`, `hardhat_*`,
  `personal_*`, compared in lower case (eRPC's allowlist already drops them; second layer).
  `RPC_GUARD_ALLOW_ADMIN=1` lets them through, except unsigned sends from a dev key or to the reference.

Everything else is forwarded byte for byte, single and batch. In a batch with a rejected call only the accepted calls
are forwarded and the answers are merged back in request order; notifications (no `id`) get no answer.

Env: `RPC_GUARD_PORT` (8546), `RPC_GUARD_UPSTREAM` (http://anvil:8545), `RPC_GUARD_REF` (comma-separated reference
addresses), `RPC_GUARD_TARGETS` (comma-separated TicketBook, HouseVault and USDG addresses from
deployments/book.json; set it so the guard accepts opens before the bell answers), `RPC_GUARD_BELL_URL`
(http://bell:8787; the `/state` book's reference, ticketBook, vault and usdg are merged in every 5 s until a target is
known, then every 60 s; the last known book is kept), `RPC_GUARD_ALLOW_ADMIN`. Health: `GET /health` (local, with
counters and `ready`, false while no target is known).

Residual risk: the targets themselves never relay calls, so a signed round can reach the reference only through dev
key 1's signature on a direct call, which the target rule rejects. Bypass: point eRPC's upstream back at
anvil:8545.

    bun install && bun test
