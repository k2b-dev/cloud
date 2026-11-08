# Files as typed input

> **Placeholder.** Typed file references for Code (FileRef) are being built in
> slice 4g of the Gustav gate and are **not available** on this version.
> Until this page describes them, do not promise Code that reads file
> content, receives attachments as input or writes files.

What works today:

- Read file and folder metadata with the `filesv2` Queries, for example
  `filesv2.entry.list` and `filesv2.entry.read` ([Capabilities](capabilities.md)).
- Read mail attachment metadata from `mail.message.read` (`attachments`).
- File content streams (`filesv2.content.read`, `filesv2.content.create`)
  are not in the Code SDK; `code_check` reports `code_stream`.

A one-off analysis of a file in this chat uses `code_run` from
`assistant-code-mode` instead.
