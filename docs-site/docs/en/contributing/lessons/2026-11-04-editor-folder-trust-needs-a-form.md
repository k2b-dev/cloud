### An automatic editor permission saved folder trust

- **What happened:** `cld acp` offered **Trust this folder** as an always-allow choice in the editor's permission prompt. An editor that approves tools automatically could save a foreign repository's `AGENTS.md` and Skills as trusted for every later session in that folder, including terminal sessions.
- **Root cause:** Lasting trust in model instructions was offered on a question channel that the editor can answer without a person.
- **Error class:** A lasting trust decision goes to a channel that can answer automatically.
- **Guard:** `acp.test.ts` answers every permission prompt with its strongest choice and checks that no always-allow choice exists and no folder is saved; lasting trust is saved only from a form.
