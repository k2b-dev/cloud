### Keep unattended policy choices aligned with execution

- **What happened:** Code administration offered approval and automatic execution for actions the runner always refuses unattended. Legacy Code mandates also lacked a visible reconfirmation hint and a one-version transition.
- **Root cause:** Policy presets and editing controls did not express the bridge's unconditional restrictions; version activation preserved legacy entries without a transition pause.
- **Error class:** Configuration and lifecycle behavior diverge from the enforced execution contract.
- **Guard:** `policy.test.ts`, `policy.integration.test.ts`, `admin.integration.test.ts`, `authoring.integration.test.ts`, `CodeArea.browser.test.ts`, `bridge.integration.test.ts`, and `activation.integration.test.ts` cover normalization, capability JSON Schema compilation, visible migration pauses, fixed controls, actual-call approval, and the legacy version switch. Admin group-edit fixtures use an eligible silent row; authoring fixtures declare the real Action policy and assert its checked classification.
