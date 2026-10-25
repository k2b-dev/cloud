### Exercise transport deadlines after response headers

- **What happened:** The Web Push streaming-response test could time out before its response fixture was ready.
- **Root cause:** The real 80 ms total deadline included connection setup, while the test awaited headers before observing rejection.
- **Error class:** A wall-clock fixture race misses the transport phase it intends to test.
- **Guard:** The test observes the outcome immediately, waits for real local response headers, advances a controlled clock by 5 ms and receives another body chunk. It then checks that both streams remain open at 79 ms and are destroyed and disconnected at 80 ms. Caller cancellation and the total-deadline tests retain real timers; no timeout is increased.
