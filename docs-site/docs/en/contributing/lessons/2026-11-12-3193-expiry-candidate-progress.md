### Keep blocked rows from exhausting a bounded maintenance batch

- **What happened:** A full batch of unused databases with queued event runs prevented later databases from expiring.
- **Root cause:** The candidate query repeatedly selected rows that the deletion guard refused. Queued event runs can persist while their Code is paused.
- **Error class:** Permanently blocked candidates starve a bounded maintenance job.
- **Guard:** A frozen-clock retention integration test fills a batch with queued event runs, verifies later expiry and confirms that setting changes still refresh every blocked database's visible deadline.
