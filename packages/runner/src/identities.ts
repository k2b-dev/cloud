let nextUid = 20000;
/** Never reuse outer Linux identities during a supervisor lifetime, including namespace mappings. */
export function allocateRunnerIdentities(count = 1) {
  if (nextUid + count > 0x7fffffff) throw new Error("runner_isolation_uid_exhausted");
  const first = nextUid;
  nextUid += count;
  return first;
}
