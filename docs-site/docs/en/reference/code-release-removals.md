---
title: Removed in the Gustav release
navTitle: Gustav release removals
section: Reference
order: 1252
description: Every public route, command, capability, setting and export the Gustav release removes, with its replacement.
tags: [deprecations, migrations, code, compatibility]
updated: 2026-11-08
---

# Removed in the Gustav release

This release retires Studio, Mail rules, automatic replies and scheduled
Assistant routines in favour of Code. Callers of the items below break at the
upgrade; there is no compatibility route. Follow
[Upgrade to Code](/en/docs/operations/upgrade-to-code) for the cut itself.

Each row names its replacement, or **none**. "Retained" marks what stays on
purpose. Grids and the public workflow engine `@k2b/cloud/workflows` are not
affected.

## HTTP routes

| Removed | Replacement |
| --- | --- |
| `GET`, `POST /api/ai/tasks`; `GET /api/ai/tasks/status`; `GET`, `PATCH`, `DELETE /api/ai/tasks/:taskId`; `POST /api/ai/tasks/:taskId/pause`, `/resume`, `/run`; `GET /api/ai/tasks/:taskId/occurrences/:occurrenceId`; `GET /api/ai/tasks/activities` | Personal Code with `app.schedule`; see [Routines became Code](/en/docs/operations/routines-to-code) |
| `/api/assistant/artifacts/*` (Studio apps, revisions, access, storage, databases, presentations, admin resources and settings) | None |
| `/api/assistant/artifacts/machine/*` (Studio machine execution, source, storage, grants and secrets) | None |
| `/api/assistant/runner/*` (hosted Studio apps) | None |
| `/app/assistant/apps`, `/app/assistant/apps/:id`, `/:id/run`, `/:id/edit`, `/:id/database` | None |
| `/admin/assistant` (Studio administration) | None |
| `/api/mail/mailboxes/:mailboxId/workflows` and everything below it: versions, restore, activate, deactivate, validate, try, autocomplete | Mailbox Code; see [Mail automations with Code](/en/docs/platform/mail-code-automations) |
| `/api/mail/mailboxes/:mailboxId/incoming-automations` and everything below it, including backfills and Spaces destination lookups | Mailbox Code with `app.on("mail.message.received")`; catch-up on the mailbox's Code page |
| `/api/mail/mailboxes/:mailboxId/automatic-replies`, `/:configurationId`, `/preview` | None |
| `POST /api/mail/mailboxes/:mailboxId/automation-log/:itemId/undo` and `/redo` | None |
| `/api/mail/admin/workflow-ai` | None |
| `/app/mail/:mailboxId/automations`, `/incoming`, `/workflows`, `/replies`, `/activity` | The mailbox's **Code** page |

Retained:

- `GET /api/ai/tasks/export` and `GET /api/ai/admin/tasks/export` read the
  frozen routine definitions.
- `GET /api/mail/mailboxes/:mailboxId/automation-export` and
  `GET /api/mail/admin/automation-export` read the old Mail rule definitions.
- `GET /api/mail/mailboxes/:mailboxId/automation-log`,
  `/automation-log/:itemId`, `/retired-runs` and
  `/conversations/:conversationId/automation-trace` read retired rule history.
- `/code/<code-id>/…`, `/app/assistant/code/:codeId` and the mailbox `/code`
  page.

## CLI commands

| Removed | Replacement |
| --- | --- |
| `cld assistant tasks list`, `get`, `create`, `update`, `delete`, `pause`, `resume`, `run`, `run-get`, `status`, `activities` | `cld code` for personal Code; Gustav builds it |
| `cld assistant code …` (Studio apps and actions) | `cld code` for lasting Code; chat `code_run` for one-off scripts |
| `cld assistant studio-admin …` | None |
| `cld admin studio machines access list`, `set`; `cld admin studio machines secrets list`, `set`, `delete` | None; Code secrets use `cld code secret` |
| `cld mail workflow …` (list, get, create, update, activate, deactivate, validate, try, export, version …) | `cld code` for mailbox Code; `cld mail automation export` for old definitions |
| `cld mail automation list`, `get`, `create`, `update`, `delete`, `catalog`, `backfill start`, `backfill status`, `backfill cancel` | Mailbox Code; catch-up on the mailbox's Code page |
| `cld mail automation log`, `log show`, `log undo` | **Retired rule history** in the mailbox menu; no Undo |
| `cld mail automatic-reply list`, `create`, `update`, and the `--automatic-replies` option of the mailbox settings command | None |
| The `--automation` option of `cld mail identity add` and `cld mail identity configure` (automatic replies from a sender identity) | None |

Retained: `cld assistant tasks export` and `cld mail automation export`, for
the definitions saved before the upgrade.

## Capabilities

| Removed | Replacement |
| --- | --- |
| Type `core.ai.task`; queries `core.ai.task.read`, `core.ai.task.run.read`, `core.ai.tasks.list`; actions `core.ai.task.create`, `update`, `delete`, `pause`, `resume`, `run` | `core.ai.chat.run` and `core.ai.chat.deliver` from personal Code |
| Type `assistant.app`; queries `assistant.app.read`, `assistant.app.search` | None. Old `assistant.app` and `assistant.artifact` references report the resource as unavailable. |

Mail removes no capability: rules and automatic replies had none.

## Assistant Skills and help

| Removed | Replacement |
| --- | --- |
| Skill `scheduled-tasks` | Skill `code-authoring` |
| Studio parts of the `assistant-code-mode` Skill (apps, app actions, publishing, source workflow, storage, database, access, management) | Skill `code-authoring` for lasting Code |
| Mail help pages for rules and workflows | Mailbox Code in the Mail help and in [Mail automations with Code](/en/docs/platform/mail-code-automations) |

## Settings and environment variables

| Removed | Replacement |
| --- | --- |
| `assistant.rsql_url`, `assistant.rsql_api_token`, `assistant.rsql_allowed_targets` | None. Keep the stored values readable until the upgrade's RSQL cleanup has finished. |
| `assistant.storage_file_mib`, `assistant.storage_total_mib` | None |
| `ASSISTANT_RSQL_ALLOWED_TARGETS`, `CLOUD_CLI_CHROMIUM` | None; the Assistant image no longer installs Chromium |
| Mailbox setting for who manages automatic replies (`automaticReplyManagementPermission`) | None |
| Sender identity input `authenticationPolicy.automation` | None |

Retained: `mail.workflow_ai_body_max_chars` and `MAIL_WORKFLOW_AI_BODY_MAX_CHARS`
now bound the Mail body that conversation summaries read.

## Package exports

| Removed | Replacement |
| --- | --- |
| `@k2b/cloud/ai`: `aiChatTasks`, `AiChatTask*`, `ChatTask*`, `CHAT_TASK_REASON_CODES`, `AiConversationIdSchema`, `AiBackgroundApprovalRequiredError`, `authorizeBackgroundAction`, and the routine helpers `chatTaskCreateFingerprint`, `chatTaskName`, `getChatTaskTimezone`, `normalizeChatTaskSchedule`, `toAiChatTaskOccurrenceView`, `toAiChatTaskView`, `chatTaskLocale`, `chatTaskNeedsNewTime`, `chatTaskReasonSentence`, `chatTaskReasonState`, `chatTaskStopSentence` | None. The read-only `ChatTaskExport*` contract stays. |
| `@k2b/cloud/services`: `TaskGrant*` | `MandateGrant*`, the retained grant contract |
| `@k2b/cloud/ai/browser`: `CodeActionInput`, `CodeCheckInput` (Studio inputs of the code tools) | The Code authoring contracts of `cld code` and Gustav's Code tools |

Third-party applications built on `@k2b/cloud/workflows` keep working. Those
that call Studio machine endpoints, routine routes or the removed exports
must change before they upgrade.
