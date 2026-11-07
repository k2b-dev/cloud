### A late device poll removed the next pairing QR

- **What happened:** In the App-PWA example, a delayed status for an already paired device removed a new device's QR.
- **Root cause:** Starting a mutation kept the old poll's generation, and any active device response could clear the displayed QR.
- **Error class:** A stale poll overwrites a newer action.
- **Guard:** The deterministic DOM test `examples/app-pwa/test/Staff.test.ts` delivers the old response after the new QR, then confirms the new device. Mutations cancel and invalidate earlier polls; confirmations match the selected device and QR.
