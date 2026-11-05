### The chat composer kept its own edge after the shared field edge changed

- **What happened:** After the shared 2 px field edge (Line B), the chat composer still drew a 1 px border with a shadow in the assistant card and a 1 px edge that appeared only on focus in the conversation pill.
- **Root cause:** The composer styles its own field outside the shared field rules, and the field edge browser contract listed only the form inputs, so nothing measured the composer.
- **Error class:** A shared UI contract reaches only the instances its test enumerates; a field with its own markup drifts silently.
- **Guard:** `packages/ui/src/styles/control-edge.browser.test.ts` ("field edge contract") now measures both composer variants in light and dark at 1280 and 390 px: 2 px edge in rest, hover, focus, error and disabled, no shadow, unchanged box and text position.
