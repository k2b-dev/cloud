### A lost Chat create response allowed a duplicate

- **What happened:** On 2026-10-21, retrying a new group chat or an explicit second chat after a lost creation response could create another chat ([#1194](https://github.com/k2b-dev/cloud/issues/1194)).
- **Root cause:** Member-set matching intentionally skips group entries and `allowDuplicate`; neither the service nor the dialogs identified one immutable creation request across retries.
- **Error class:** Lost creation response duplicates an intentional new resource.
- **Guard:** Chat's conversation integration tests race subject-scoped create keys, discard accepted responses, reject changed payloads and recheck current access. Dialog behavior and browser recovery tests retain the same request through failure, dismissal and reload, then assert exactly one new chat. Explicit cancellation starts a new intent; successful server mappings share their chat and subject lifetime.
