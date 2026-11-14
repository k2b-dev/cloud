### Wait for each independent sender lookup

- **What happened:** The Mail sender-card browser test sometimes found no address after its earlier-conversation list appeared. Its suite wrapper also reported failure, making one assertion look like two failures.
- **Root cause:** Contact details and conversation history load independently. History readiness does not mean the contact lookup has finished replacing its placeholders with the address and error recovery controls.
- **Error class:** A test treats one asynchronous branch as proof that another branch completed.
- **Guard:** The sender-card browser case holds the contact response until history appears, then waits for the expected contact-error state before checking the address, Retry and sender actions. The existing timeout is unchanged.
