### The toast copy rule reported every v2 toast as untitled

- **What happened:** Lanes moving screens to `@k2b/ui/v2` got one `untitled` finding per `toast(message)` call, although a v2 toast has no separate title.
- **Root cause:** `scripts/checks/toast-copy.ts` knew only the v1 contract, a title plus a description. In v2 the message stands in the title's place, so the rule measured a contract the call does not have.
- **Error class:** A repository rule written for one version of an API judges calls to its successor by the old contract.
- **Guard:** The rule recognizes `useToast` from `@k2b/ui/v2` and checks v2's own contract, one sentence per toast (finding `v2-sentences`). `scripts/checks/toast-copy.test.ts` covers one long sentence, a catalogue message, two sentences and a v1 toast beside a v2 import.
