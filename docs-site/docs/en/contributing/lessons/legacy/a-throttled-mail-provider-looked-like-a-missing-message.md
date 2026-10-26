### A throttled Mail provider looked like a missing message

- **What happened:** Empty reads could fail commands as missing, confirm deletes or moves, mark bodies missing, or retire local messages ([#1244](https://github.com/k2b-dev/cloud/issues/1244)).
- **Root cause:** ImapFlow ends FETCH without rows when its throttle retries run out. SEARCH returns false on command failure. Mail treated these answers as absence.
- **Error class:** Absence from an empty provider answer.
- **Guard:** `%s confirms an empty FETCH answer before it reports a message as gone` in `packages/mail/src/service/connectors/imap-smtp.test.ts` drives real ImapFlow against a throttling server for every affected read. New reads that infer absence use the same confirmation helper. A source the provider lists but never delivers still uses the missing-source budget (`downloadSourceBatch skips a source the provider lists but never delivers and streams the rest`).
