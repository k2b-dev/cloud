### Editor threads hide tool results and fail on folders

- **What happened:** In `cld acp`, a finished tool call showed nothing in the editor, and a result over 16 KB lost even its raw output. Attaching a folder aborted the message, an embedded file with a relative URI threw, `session/list` reported the requested folder for every chat, and a stopped `cld` left its temporary session folders behind.
- **Root cause:** Tool updates carried content only for failures, attachments assumed every file link is a file and every resource URI is absolute, the session mapping stored no folder, and only a clean stdin end ran the cleanup.
- **Error class:** A text alternative drops what the richer client shows.
- **Guard:** `packages/assistant/src/cli/acp-updates.test.ts` "ACP tool results" checks visible results bounded in their final form, with a notice, and that only a successful create shows a diff. `acp.test.ts` "ACP attachments, sessions and cleanup" sends a folder and a relative resource, lists sessions by folder, also with two threads on one chat, closes a session while a resume waits, and sends SIGTERM to a real child process to check that its session folder is gone.
