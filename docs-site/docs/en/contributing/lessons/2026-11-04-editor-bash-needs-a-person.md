### An automatic editor permission ran local Bash

- **What happened:** In an editor without form support, `cld acp` asked for local Bash through the editor's permission prompt. An editor that approves tools automatically ran the command, which could read the `cld` login and act as the person, for example to approve a request that only Cloud may confirm.
- **Root cause:** The bridge offered Bash on a question channel that the editor can answer without a person, and Bash runs with the person's local access.
- **Error class:** A question that guards local code execution goes to a channel that can answer automatically.
- **Guard:** `acp.test.ts` answers every permission prompt automatically and checks that a client without forms is not offered `local_bash`, that a forged call is refused without running, and that clients with forms still ask through a form.
