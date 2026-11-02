### Consume the capability result envelope exactly once

- **What happened:** The Code page showed an error for valid Core results; attention and browser actions also expected an extra data envelope.
- **Root cause:** Page consumers wrapped domain schemas in `{ data }` before passing them to capability clients, which already validate that envelope. Cast test fixtures repeated the extra layer.
- **Error class:** Consumer and mock agree on a transport shape that the real provider never emits.
- **Guard:** C25 loads the Code page through real Core declarations. Page helper fixtures validate canonical provider payloads against the supplied schema, and browser behavior tests check action response schemas.
