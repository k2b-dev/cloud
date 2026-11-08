### Verify measured results within the remaining deadline

- **What happened:** A completed transfer phase could show zero without measuring bytes, while final verification rejected a responsive server after only 250 ms despite unused time in the test deadline.
- **Root cause:** Phase completion did not require measured bytes, and verification used its minimum reserve as a fixed timeout.
- **Error class:** Premature completion and unnecessary failure at a bounded operation's final stage.
- **Guard:** Fixed-clock engine tests reject phases containing only warmup bytes, permit a 750 ms final check after early completion, and still stop hanging verification at the whole-test deadline. Verification publishes its own phase with a decreasing countdown.
