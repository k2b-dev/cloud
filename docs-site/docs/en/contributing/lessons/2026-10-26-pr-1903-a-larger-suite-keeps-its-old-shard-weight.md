### A larger suite keeps its old shard weight

- **What happened:** Chat gained browser scenarios while its committed unit-suite weight stayed at 333.5 seconds; the measured 631.2-second suite grouped with Spaces and exceeded the unchanged 20-minute shard budget.
- **Root cause:** The shard planner still used Chat’s old 333.5-second weight after its measured suite duration grew to 631.2 seconds.
- **Error class:** A larger suite keeps its old shard weight
- **Guard:** Existing runner budget enforcement and weighted-shard tests detect the class. Update the affected suite weight from the completed CI timing when adding expensive scenarios; keep the job and shard deadlines unchanged.
