### A UI job repeated tests already covered by the unit shards

- **What happened:** The UI job hit its 30-minute deadline after 4,499 tests passed in [#3649](https://github.com/k2b-dev/cloud/pull/3649), aborting the final fixture build ([#3654](https://github.com/k2b-dev/cloud/issues/3654)).
- **Root cause:** The UI job repeated suites already selected by the unfiltered, sharded unit runner; meanwhile, the standalone fixture render test was outside both commands' selected paths.
- **Error class:** A job repeats a suite that the sharded runner already covers.
- **Guard:** `scripts/checks/ci-gate.test.ts` rejects a test command in the UI build job. `scripts/run-tests.test.ts` compares all UI files from `listTestFiles` against the actual unit matrix's parts and behavior commands, requiring every file and the packed-consumer check exactly once; the fixture render test is now included. The existing measured unit-shard budget guard remains in place.
