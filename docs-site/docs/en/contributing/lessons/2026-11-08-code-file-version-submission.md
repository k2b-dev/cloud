### Keep version submission aligned with the generated file SDK

- **What happened:** A checked program using a file read or generic file write could not save a version.
- **Root cause:** Submission rejected all streaming operations although the generated SDK and execution bridge support FileRef reads and writes with file metadata input.
- **Error class:** Contract drift between authoring and submission.
- **Guard:** The version submission integration test saves read-stream and generic file-write manifests and refuses unsupported write streams without saving a version.
