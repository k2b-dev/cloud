### Late admitted input must not strand a send boundary

- **What happened:** An edit admitted between command thaw and asynchronous access revocation could leave a failed dispatch frozen or an accepted send permanently awaiting close.
- **Root cause:** Snapshot persistence rejected noneditable content without a domain error; retirement compared the late state with an already sent command forever. Mail now reports SEND_CONTENT_CHANGED before SMTP, uses the platform release of a definitely failed freeze, and drains sent tombstones without rewriting or comparing the outbound snapshot.
- **Error class:** Treating asynchronous revocation as an instantaneous domain fence.
- **Guard:** `packages/mail/src/service/sent-projection.integration.test.ts` admits a real broker update after thaw, proves dispatch refusal and immediate editing, and checks accepted/unknown tombstone retirement with a crash before the close freeze.
