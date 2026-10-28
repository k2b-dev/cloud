### Storage test deadlines

- **What happened:** A test expires before the request it intends to stall; a multi-action loop can also leave fault injection running into another case.
- **Root cause:** Accelerated deadlines expire prerequisite I/O, or several independent storage cases share one deadline.
- **Error class:** Accelerated deadlines expire prerequisite I/O, or several independent storage cases share one deadline.
- **Guard:** Files CLI and TCP upload fixtures trigger the mocked deadline at the intended stalled request or completed PUT. Parameterized version-writer tests verify each action independently. Evidence: `packages/filesv2/src/service/version-activity.integration.test.ts`, `packages/filesv2/src/cli-upload.test.ts`, and `packages/filesv2/src/upload-transfer.test.ts`; existing production and test deadlines are unchanged.
