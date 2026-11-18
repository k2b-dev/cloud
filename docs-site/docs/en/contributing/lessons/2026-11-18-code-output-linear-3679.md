### Code output parsing revisited the same suffix for repeated OSC prefixes

- **What happened:** Long run-output lines with repeated OSC prefixes could require quadratic parsing work before an incomplete escape.
- **Root cause:** The OSC expression accepted another C1 OSC prefix inside its body. When a later escape could not terminate the sequence, matching retried the same suffix from each prefix.
- **Error class:** Repeated suffix scans in output parsing.
- **Guard:** The `failed OSC prefixes take linear character reads on long output without a timing assertion` test in `packages/cloud/src/code/output.test.ts` counts scanner reads for 100,000 and 200,000 prefixes, checks a linear bound, and verifies proportional growth. Boundary tests preserve OSC, string sequence, CSI, generic escape, and Unicode handling.
