// Gas limit headroom for every write the site sends. The playground clock can land a block between the estimate and
// inclusion, and a transaction sent with the bare estimate then runs out of gas (seen on the rig, fixed there in
// infra/ops/rig/open-ticket.sh). 30% over the estimate, rounded up.
export function withHeadroom(estimate: bigint): bigint {
  return (estimate * 13n + 9n) / 10n;
}
