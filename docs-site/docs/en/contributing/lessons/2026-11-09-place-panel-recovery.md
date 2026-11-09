### Keep panel navigation and creation recovery scoped to their origin

- **What happened:** A cancelled place-chat opening left following enabled. Unknown creation retries could reuse a different place's request, and concurrent creation or withdrawn consent left the panel stuck.
- **Root cause:** Navigation cleanup belonged only to the winning request, creation identity was keyed only by the empty composer, and the rendered place snapshot outlived consent.
- **Error class:** Async state and identity reused beyond their original scope.
- **Guard:** Assistant's place browser tests cancel an in-flight chat open, switch after both ordinary and place creation failures, recover a concurrent creation without sending the local draft, and withdraw context. The controller behavior test checks that background reconciliation cannot invalidate a foreground chat load. The starters render from a keyed place snapshot so removing it cannot dereference null.
