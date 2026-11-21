let nextUid = 20000;
/** Never reuse outer Linux identities during a supervisor lifetime, including namespace mappings. */
export function allocateRunnerIdentities(count = 1) {
  if (nextUid + count > 0x7fffffff) throw new Error("runner_isolation_uid_exhausted");
  const first = nextUid;
  nextUid += count;
  return first;
}

const reapedJobRanges: number[] = [];
/** Recycle only after the namespace init and launcher are reaped; no process or private tmpfs survives.
 * Production identities are never recycled and never overlap an allocated job range. */
export function reserveJobIdentities() {
  const first = reapedJobRanges.pop() ?? allocateRunnerIdentities(65536);
  let released = false;
  return {
    first,
    release: () => {
      if (!released) {
        released = true;
        reapedJobRanges.push(first);
      }
    },
  };
}
