### A build renderer counted scheduler delay as decoding work

- **What happened:** The installable icon test failed after ten seconds with only "Installable icon worker failed" (#3184).
- **Root cause:** The build killed its isolated renderer after ten wall-clock seconds, including time waiting for CPU. A local run with a 2% CPU quota reproduced the failure. These fixed Tabler assets are build inputs, not a live request with a response deadline.
- **Error class:** A background CPU budget is enforced as elapsed time, so contention is mistaken for excessive work.
- **Guard:** The build uses a ten-second CPU limit while request decoders retain their wall-clock deadlines and all workers retain memory isolation. `canvas-worker.test.ts` checks idle time, runaway CPU work, exit signals and bounded stderr diagnostics; `installable-assets.test.ts` checks all eight output images under CPU throttling.
