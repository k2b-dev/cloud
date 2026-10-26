# Passage comments

Use `cld notebooks annotations` to discuss a Markdown passage, reply, resolve
comments, and accept replacement suggestions. Every command takes the same
note addresses as `cat`: a note ID, `Notebook:path`, or a mirror file.
Annotation and reply IDs are UUIDs returned by these commands.

```sh
cld notebooks annotations list Ab12Cd --json
cld notebooks annotations add Ab12Cd --quote 'old wording' --content 'Use the current name.' --suggestion 'new wording' --idempotency-key review-1
cld notebooks annotations reply Ab12Cd <annotation-id> --from reply.md --idempotency-key reply-1
cld notebooks annotations edit Ab12Cd <annotation-id> --content 'Updated explanation'
cld notebooks annotations resolve Ab12Cd <annotation-id>
cld notebooks annotations reopen Ab12Cd <annotation-id>
cld notebooks annotations accept Ab12Cd <annotation-id> --operation-id <uuid> --yes
cld notebooks annotations undo Ab12Cd <annotation-id> --operation-id <another-uuid> --yes
cld notebooks annotations delete Ab12Cd <annotation-id> --yes
cld notebooks annotations restore Ab12Cd <annotation-id>
```

Read access can list; every mutation needs write access. These rules apply to
people, agents, and service accounts. Only the author may edit, delete, or
restore a root or reply, within ten minutes of posting. A root with live
replies cannot be deleted. `edit`, `delete`, and `restore` accept `--reply <id>`.
Locked notes allow comments, replies, and status changes; accepting and undoing
suggestions require an unlocked note.

`add` accepts `--from <file|->` or `--content <text>` for the comment body.
Supply a body or a suggestion that differs from the quote. Quotes and
suggestions allow 2,000 UTF-16 characters; bodies allow 5,000. An empty
`--suggestion ''` suggests deletion. `edit --remove-suggestion` removes a
suggestion; omitting it preserves the current suggestion.

When the quote occurs more than once, pass exact `--prefix` and `--suffix`
context (up to 32 characters each), or `--offset-hint <n>`. Offsets count UTF-16
characters in the note Markdown, excluding mirror front matter. The server
refuses missing or ambiguous passages with HTTP 409.

Reuse `--idempotency-key` for retries of one add or reply with identical input.
Using the same key with different content returns 409. Accept and undo require
a stable `--operation-id <uuid>`; reuse that UUID if saving failed or the
outcome is uncertain. `--expected-text` overrides the expected quote on accept.
Undo restores only the inserted range if it still contains the accepted text;
it never restores the whole note.

Lists return `{ text, contentHash, cursor, restoreRevision, items, nextCursor }`.
`from` and `to` are UTF-16 offsets into exactly `text`, including when saved
Markdown lags behind live typing. A comment includes `orphan`, `quote`, `body`,
`suggestion`, `state`, author/provenance, current edit/delete permissions,
`headingPath`, and a bounded page of `replies`. Open, resolved, and accepted
comments are included; deleted comments are omitted. Follow `nextCursor` with
`--cursor`. Pages contain at most 30 comments and may be shorter to fit the
response budget.

Use `list <note> --annotation <id>` to read one thread. Continue its
`repliesNextCursor` with
`list <note> --annotation <id> --replies --cursor <cursor>`. Replies have the
same 30-item and response-byte bounds. `canEdit` and `canDelete` describe the
current caller. `via` is `assistant`, `mcp`, or `null`, assigned from trusted
platform provenance; it cannot be supplied as input.
