### Estimate upload time from transferred bytes

- **What happened:** A large upload on a slow connection showed a file count without a useful remaining time.
- **Root cause:** The queue tracked byte progress but supplied no throughput estimate to its panel.
- **Error class:** Progress feedback omits the cost of remaining work.
- **Guard:** `upload-estimate.test.ts` covers byte weighting, small files, resumed receipts and smoothing. `UploadPanel.browser.test.ts` checks the estimate, stable controls and hiding it during a network wait.
