#!/usr/bin/env bash
# open-ticket.sh <rpc> <book> <TICKER> <horizon 0|1|2> [stake raw] [leverage] -> prints "id <n> owner <addr> block <n> expiry <ts>"
# Fresh key funded with anvil_setBalance and the USDG balance slot keccak256(abi.encode(addr, 1)). The id comes from
# this transaction's TicketOpened log (topic 1), not from ticketCount(), so concurrent opens each report their own id.
set -euo pipefail
RPC=${1:?rpc}; BOOK=${2:?book}; TICKER=${3:?ticker}; H=${4:?horizon}; STAKE=${5:-20000000}; LEV=${6:-5}
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
w=$(cast wallet new --json); KEY=$(jq -r '.[0].private_key' <<<"$w"); ADDR=$(jq -r '.[0].address' <<<"$w")
cast rpc anvil_setBalance "$ADDR" 0x8AC7230489E80000 --rpc-url "$RPC" >/dev/null
slot=$(cast keccak "$(cast abi-encode 'f(address,uint256)' "$ADDR" 1)")
cast rpc anvil_setStorageAt "$USDG" "$slot" "$(cast to-uint256 1000000000)" --rpc-url "$RPC" >/dev/null
cast send "$USDG" 'approve(address,uint256)' "$BOOK" "$STAKE" --private-key "$KEY" --rpc-url "$RPC" | grep -E "^status"
SYM=$(cast format-bytes32-string "$TICKER")
# Gas limit with 30% headroom over the estimate: cast sends the bare estimate, and the playground clock (an empty block
# the bell mines every bar) or another open can land between estimate and inclusion, which made an exact-estimate
# open run out of gas on the rig (gas limit equal to gasUsed, reseed step j probe).
gas=$(cast estimate "$BOOK" 'open(bytes32,bool,uint8,uint256,uint8)' "$SYM" true "$LEV" "$STAKE" "$H" --from "$ADDR" --rpc-url "$RPC")
rcpt=$(cast send "$BOOK" 'open(bytes32,bool,uint8,uint256,uint8)' "$SYM" true "$LEV" "$STAKE" "$H" --gas-limit $((gas * 13 / 10)) --private-key "$KEY" --rpc-url "$RPC" --json)
[ "$(jq -r .status <<<"$rcpt")" = 0x1 ] || { echo "open reverted: $(jq -c '{status,transactionHash}' <<<"$rcpt")"; exit 1; }
topic0=$(cast keccak 'TicketOpened(uint256,address,bytes32,bool,uint8,uint256,uint256,uint64)')
book_lc=$(tr 'A-F' 'a-f' <<<"$BOOK")
log=$(jq -c --arg t "$topic0" --arg b "$book_lc" '[.logs[] | select((.address|ascii_downcase) == $b and .topics[0] == $t)][0]' <<<"$rcpt")
[ "$log" != null ] || { echo "no TicketOpened log in $(jq -r .transactionHash <<<"$rcpt")"; exit 1; }
id=$(cast to-dec "$(jq -r '.topics[1]' <<<"$log")")
data=$(jq -r .data <<<"$log")   # long, leverage, stake, entryPrice8, expiry: expiry is the last word
expiry=$(cast to-dec "0x${data: -64}")
echo "id $id owner $ADDR block $(cast to-dec "$(jq -r .blockNumber <<<"$rcpt")") expiry $expiry"
