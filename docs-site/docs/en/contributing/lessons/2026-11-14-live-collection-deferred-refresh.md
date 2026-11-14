### Collection refresh tests control the deferred sweep

- **What happened:** A focused engine run observed eight collection refreshes where the test allowed four; the socket correctly remained open.
- **Root cause:** The test slept 20 ms and assumed its 50 ms deferred sweep had not fired. Scheduling delays let a second valid refresh round run before the assertion.
- **Error class:** Fixed-delay synchronization across asynchronous refresh rounds.
- **Guard:** The collection-refresh test holds the deferred timer, waits for its registration, checks the first bounded round, then explicitly resumes the deferred sweep. No elapsed pause decides which round is asserted. Tracked in #3353.
