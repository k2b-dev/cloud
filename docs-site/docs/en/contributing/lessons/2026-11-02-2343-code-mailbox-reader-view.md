### A Code owner must implement the canonical reader view

- **What happened:** Initializing Code at a Mail mailbox failed while reading its owner.
- **Root cause:** Mail declared `mailbox.read` as the canonical reader but returned domain fields without the shared `data.view` expected by Core.
- **Error class:** A declared cross-application reader omits its shared presentation contract.
- **Guard:** The Mail manifest unit test requires `typeViewIssues(manifest, "mailbox")` to be empty. The C25 acceptance integration initializes mailbox-owned Code through the real Mail reader and checks authoring, activation and subsequent execution.
