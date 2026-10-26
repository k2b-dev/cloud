### An ambiguous send duplicated a comment and a late answer removed newer input

- **What happened:** Retrying a comment after a lost response could create another comment. A send completed after leaving and reopening the task could remove the newer device draft.
- **Root cause:** Each POST allocated a new identity, and the success callback compared only its component’s old text before removing shared draft storage.
- **Error class:** Retried effects lack a stable request identity; late completion mutates newer input.
- **Guard:** The device draft retains a request UUID across retries and restart; failed text or token persistence visibly blocks the POST. A quota regression clears the helper memory before restoring only the durable text. Service and HTTP integration tests require one comment and outbox entry for repeated requests, including concurrent creation, and reject mismatched requests. Task-detail behavior tests retain the UUID across retry/restart and preserve a newer draft after a late completion.
