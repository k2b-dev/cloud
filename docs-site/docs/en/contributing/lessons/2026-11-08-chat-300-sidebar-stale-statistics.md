### The 300-chat sidebar test timed out after a bulk load with stale statistics

- **What happened:** In merge-group run 42526165208 the Chat test "a 300-chat sidebar pages every chat with bounded responses" hit its 30-second timeout and removed #2962 from the merge queue. Passing runs take about 1.5 seconds with a 58 ms p95 per page.
- **Root cause:** The test inserts 300 chats with their grants and reads the sidebar at once. Auto-analyze had not caught up on the fresh CI database, so the planner chose a plan that ran for seconds per page. The cleanup diagnostic showed the sidebar query itself active and unblocked, and the test was still in its timing loop when the timeout fired.
- **Error class:** Measuring or paging right after a bulk fixture load while the planner still uses statistics from before the load.
- **Guard:** The test runs `ANALYZE` on the access and Chat tables after loading, like the large-channel test in the same file. Tests that bulk-load rows and then measure or page through them analyze the loaded tables first.
