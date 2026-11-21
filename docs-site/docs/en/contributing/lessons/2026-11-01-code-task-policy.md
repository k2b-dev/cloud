### A remembered chat Action lacked an explicit Code policy

- **What happened:** The mailbox schedule acceptance test could not create a Space task unattended after its version was approved and activated.
- **Root cause:** Spaces task Actions declared legacy remembered chat approval, while Code requires an explicit unattended Action policy.
- **Error class:** An application declaration supports one execution surface but omits the contract required by another.
- **Guard:** Spaces capability tests check the explicit task policies and unchanged chat scope. The C25 integration test exercises approved task creation and update through the runner, mandate, and target provider. Bridge tests retain refusal coverage for delete, send, and explicitly interactive Actions.
