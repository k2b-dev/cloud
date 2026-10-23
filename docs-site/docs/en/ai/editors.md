---
title: Assistant in editors
navTitle: Editors (ACP)
section: AI
order: 1035
description: Run Cloud Assistant in T3 Code or Zed with cld acp.
tags: [ai, assistant, editors, acp, cli]
updated: 2026-10-11
---

# Assistant in editors

Run `cld acp` as an Agent Client Protocol (ACP) v1 agent in editors such as
T3 Code and Zed. It uses your Cloud login, models, usage limits, personalization,
Projects, Skills, and Cloud tools while working in the editor's project folder.
Chats stay in Cloud, where you can continue them on the web.

The local folder rules are the same as in the terminal: local tools, AGENTS.md,
Skills, folder trust, and file access follow
[Work with a local folder in cld](/en/apps/assistant#work-with-a-local-folder-in-cld).

## Set up cld

Install `cld`, then sign in:

```bash
curl -fsSL https://<your-cloud>/cli | sh
cld login --server https://<your-cloud>
```

Accept the Assistant plugin installation when offered, or install it yourself:

```bash
cld plugins install assistant
```

For an older installation, run `cld plugins update`. Sign in with `cld login`,
not an API key. Check that the command is available with `cld acp --help`.
If `acp` is reported inactive, use `assistant` and `acp` as the editor's two
arguments instead.

## Add Cloud to T3 Code

1. Open **Settings → Providers → Add provider → Local ACP command**.
2. Set the executable to `cld` and the argument to `acp`.
3. Start a thread with that provider and choose the folder as the thread's
   project folder.
4. Pick a model in the model picker. **Cloud default** uses Cloud's default.

For a named cld profile, put these arguments before `acp`, one per line:

```text
--profile
<name>
acp
```

If T3 Code cannot find `cld`, run `command -v cld` in a terminal and use that
full path as the executable.

## Add Cloud to Zed

Add a custom agent under `agent_servers` in `settings.json`:

```json
{
  "agent_servers": {
    "Cloud": {
      "type": "custom",
      "command": "cld",
      "args": ["acp"]
    }
  }
}
```

For a named profile, use `"args": ["--profile", "<name>", "acp"]`.
Select Cloud for the thread and choose its model in the model picker.

## Choose how approvals work

The editor's mode decides local questions and Cloud approvals that can be
remembered. In T3 Code, **Full access** approves them without asking;
**Supervised** asks; **Auto-accept edits** accepts appends and moves and asks
for the rest. Writing or moving a file that becomes instructions for the
assistant, such as `AGENTS.md` or a file under `.agents`, is never sent as an
edit, so this mode still asks for it.

Actions that cannot be undone or reach other people, such as sending mail,
deleting, sharing, or inviting, always wait for confirmation in Cloud. The
editor can only reject them, and shows the link to the web chat. Choosing
**Confirm in Cloud**, including an automatic choice in Full access, leaves the
request waiting until you confirm or reject it in Cloud, or on a device paired
with [Cloud Login](/en/apps/cloud-login).

Local Bash commands, replacing a file, and writing or moving a file that
becomes instructions for the assistant ask through a form that reaches a
person even in Full access when the editor supports forms. Without form
support, these questions use the editor's permission prompt.

Remembered approvals from an editor last at most for that chat. Use
`/approvals` to list and revoke them. See [Tools and approvals](/en/docs/ai/tools-and-approvals)
for Cloud's approval rules.

## Read results in the editor

| Result | What appears |
| --- | --- |
| Replies and thinking | Streamed text |
| Tool calls | Calls with their current status |
| Working checklist | The editor's plan |
| Cards and charts | Text and Markdown tables |
| Studio apps, secrets, and file previews | A link to the web chat |
| Surveys and drafts | Forms when supported; otherwise Assistant can ask or show the draft in chat. An edited draft over 20,000 characters is not sent, and Assistant asks what to shorten |

## Use chat commands

| Command | Use |
| --- | --- |
| `/web` | Show the link to this chat in Cloud |
| `/usage` | Show usage shares and reset dates |
| `/approvals [number]` | List remembered approvals or revoke one |
| `/project [number]` | List Projects or choose one for this chat |
| `/skills` | List local and Cloud Skills |
| `/<skill> [message]` | Select a Skill for the next message, or use it immediately with a message |

Choose models in the model picker. Local Skills need local tools enabled in
the cld profile.

## Continue a session

A new editor thread creates its Cloud chat with the first message. The thread
list can show Cloud chats too. Resuming a chat does not replay its history in
the editor. If a turn is still running, the editor says so, and Assistant
follows it again before sending your next message.

Closing the editor does not stop a Cloud turn. Open the web chat to continue
or answer a pending request. Use the editor's Stop action to cancel a turn.

## Limits

Assistant has no plan mode or other modes; a plan toggle in the editor has no
effect. It ignores MCP servers supplied by the editor and uses Cloud's own
tools. You cannot steer a turn while it runs. Attach at most 16 files per
message.
