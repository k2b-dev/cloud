### A wheel gesture must stay spent after it starts a refresh

- **What happened:** Overscrolling a Mail list with a trackpad slid the refresh indicator in several times, made it jitter, and could start a second reload.
- **Root cause:** `PullToRefresh` moved the indicator with every wheel event and re-armed the gesture as soon as `onRefresh` settled. The trackpad's momentum kept sending upward wheel events after a quick refresh, so the same flick pulled the indicator in again and could reach the threshold a second time. The indicator also hid at once instead of sliding out.
- **Error class:** An input without a release event (trackpad momentum) treated as a new gesture once the work it started has finished.
- **Guard:** `packages/ui/test/pull-to-refresh.behavior.test.tsx` replays a decaying momentum stream on a test clock across a quick refresh and expects exactly one refresh and one `idle → refreshing → idle` pass; a second test checks that no input starts while the indicator slides out.
