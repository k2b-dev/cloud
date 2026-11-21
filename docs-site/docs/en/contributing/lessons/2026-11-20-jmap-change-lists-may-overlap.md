### JMAP change readers rejected change lists that repeat an id

- **What happened:** The JMAP delta readers in Mail failed with `JMAP_INVALID_RESPONSE` when an `Email/changes` or
  `Mailbox/changes` response named the same id in two of the lists `created`, `updated` and `destroyed`. A server that
  sends such a list would block the sync for that account on every attempt.
- **Root cause:** `parseChanges` in `packages/mail/src/service/connectors/jmap-delta.ts` required the three lists to be
  disjoint. RFC 8620 §5.2 only recommends that form. It allows an id in `created` and `updated`, in `updated` and
  `destroyed`, and in `created` and `destroyed`.
- **Error class:** A response check accepts only the recommended (SHOULD) form of a protocol and rejects a permitted
  (MAY) form.
- **Guard:** `jmap-delta.test.ts` sends each permitted form of the change lists, alone and together with plain ids, to
  the email reader (one combined request and separate requests) and to the mailbox reader. The tests expect disjoint
  lists, each changed email exactly once in `objects` or `notFoundIds`, and no get for a destroyed id. The same id twice
  in one list and more entries than `maxChanges` still fail. When you check a response against an RFC, go through
  every MAY form one by one and add one test for each.
