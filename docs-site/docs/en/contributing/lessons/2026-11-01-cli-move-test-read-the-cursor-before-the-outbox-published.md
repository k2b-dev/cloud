### A CLI move test read the workspace cursor before the outbox published

- **What happened:** The release pull request for 0.58.0 failed on `packages/notebooks/src/cli.integration.test.ts`. Right after `cld notebooks mv`, the test found the workspace topic cursor unchanged.
- **Root cause:** Since #2262, a workspace hint is written to `notebooks.workspace_outbox` in the move's transaction, and the dispatcher publishes it after the commit. The test still read the topic cursor as soon as the command returned, as if publishing happened before the response.
- **Error class:** State sampled before it settled: a test reads the result of asynchronous delivery as if it were synchronous.
- **Guard:** The test now waits, bounded by a timeout, until the cursor moves. Tests of outbox-delivered effects wait for the delivery, as `workspace-outbox.integration.test.ts` does.
