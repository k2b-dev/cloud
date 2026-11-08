### Live sockets blocked graceful HTTP shutdown

- **What happened:** An application with open live WebSockets spent its HTTP drain budget waiting for those sockets, delaying cleanup until the container could be killed.
- **Root cause:** Shutdown awaited Bun's graceful HTTP stop before stopping live engines and app-access connections. The HTTP stop waits for the same sockets that the later cleanup would close.
- **Error class:** Shutdown dependency cycle: a drain waits for resources released only after that drain.
- **Guard:** `packages/cloud/src/_internal/define-app.live-shutdown.test.ts` starts an application with real live and app-access WebSockets, sends SIGTERM, and requires close code 1012 and process exit within five seconds. It keeps an accepted HTTP request open to verify that outbox, lifecycle, membership, heartbeat and Sync cleanup retain their order after the HTTP drain. Existing live-engine and browser live-WebSocket tests cover late sockets and reconnecting after 1012.
