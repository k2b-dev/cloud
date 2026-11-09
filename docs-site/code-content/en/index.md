---
title: feat/code
navTitle: Overview
section: Start
order: 10
description: Automate anything in plain TypeScript, with native access to every app, even your own. Your apps finally work as one.
tags: [code, automation, ai, gustav]
updated: 2026-11-09
---

# feat/code

What if workflow automation, serverless functions, typed code, your data and
your files were one thing, inside the platform that already holds your mail,
tasks and tables? That is feat/code. Code reacts to events, runs on a
schedule, calls every Cloud app, asks AI for help and serves its own pages.

Gustav writes it, you approve it. You can also write it in your editor. Cloud
checks it, an administrator approves what needs approval, a person switches it
on, and every call it makes is checked and logged.

- **Workflow automation:** automations start from an event or a schedule and
  call any app: tag a mail, create a task, post into a chat. As code, not boxes
  and arrows.
- **Serverless functions:** sandboxed TypeScript with routes and pages under
  `/code/<id>/`. No server, no deployment, no credentials in the source.
- **Typed code:** an SDK that your installation generates from its apps. Your
  editor and the checker know every operation, input and result.
- **Your data:** shared data stays in tables people already see, in Grids,
  Spaces and Mail. For its own state, every Code has its own SQL database.
- **Your files:** attachments and documents pass from one app to another as
  references, and AI can read them, without the bytes ever entering the Code.

## See it

Code of a fictional mailbox `invoices@`. When a message arrives, AI decides
whether it is an invoice, and the Code tags the conversation:

```ts
import { app, core, mail, owner } from "@sdk";

const invoiceTagId = "Tag042"; // fictional; read real IDs through the SDK

app.on("mail.message.received", async (event) => {
  let { data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true });
  while (message.hydrationStatus !== "complete") {
    ({ data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true }));
  }
  if (!message.conversationId) return;

  const { data: result } = await core.ai.decide({
    task: "mail.invoice",
    state: { subject: message.subject, text: message.text?.slice(0, 4000) ?? "" },
    questions: { invoice: { type: "noul", instructions: "Is this an invoice or a payment reminder?" } },
  });
  const answer = result.answers.invoice;
  if (answer?.type !== "noul" || answer.probability < 0.9) return;

  const { data: conversation } = await mail.conversation.read({ id: message.conversationId });
  await owner.conversation.tag.update({
    conversationId: message.conversationId,
    expectedRevision: conversation.collaboration.revision,
    addTagIds: [invoiceTagId],
  });
});

export default app;
```

Before this runs, the checker lists exactly what it touches: four operations,
each with its file and line, and this mailbox as the target of the tag change.
With the default policy, AI use needs an administrator's approval. After that,
each new message starts one run, and the mailbox's Code page shows every run
with every call.

## Why it exists

**Automation belongs where the work is.** External automation tools hold copies
of credentials, poll APIs and fail where nobody looks. Code runs inside Cloud as
an account Cloud knows, with the same permissions, approvals and audit as a
person. When it fails, the owner sees it on the Code page.

**AI should do real work, under the same rules.** `core.ai.generate` and
`core.ai.decide` summarise, extract and classify. In a model loop, the model
calls the SDK methods you hand it as tools, and it can look at the files you
pass. Every tool call is an ordinary SDK call of the same account, checked
against the same policy and written to the same log. The account pays from its
own AI allowance.

**Software that extends itself, under control.** With Gustav, the people who
use Cloud can add the pages and automations they miss, without waiting for a
release. That only works when nothing runs unseen. So every version is
immutable, the checker shows each operation with its file and line, policy
decides what needs an administrator, a person switches it on, and the people
responsible for it can pause it at any time.

**Unopinionated.** Cloud does not decide your policy. App authors decide what
their operations do and whether they ask a person. You decide what your Code
does and who may open its pages. The administrator decides what may run
unattended.

## The loop

1. **Build** in a Gustav chat or locally with `cld code`.
2. **Check:** the checker reads the source and lists every operation with its
   target, file and line.
3. **Test** with fixtures: a fixed clock and fictional replies. Nothing real
   is called.
4. **Submit** an immutable version. If the policy requires it, a Cloud
   administrator approves exactly this version.
5. **Switch on:** the owner, or a person who manages the owning resource.
6. **Run** as exactly one account. Every call checks that account's current
   rights, the policy and the approved version.

## Who the Code runs as

Code always runs as exactly one account: its execution owner.

| Owner | Runs as | Good for |
| --- | --- | --- |
| You (personal Code) | you, with your current rights | a weekly report into your Gustav chat, a form that files your tasks |
| A resource, such as a mailbox | the resource's own service account | sorting, tagging and summarising incoming mail, a dashboard for the team |
| An application | the application's service account | automations that belong to an app rather than one resource |

A service account starts without rights. Whoever manages a target shares View or
Edit with it, the same way they share with a person, and can take it back.

## Your data

Shared data lives where people see it: in Grids, Spaces and Mail. For its own
state, every lasting Code has its own SQLite database. Cloud creates it on the
first `db` call. It survives new versions, and deleting the Code or its owner
deletes it too.

- `db.query` reads rows, `db.exec` runs one write or schema statement, and
  `db.batch` runs several statements that commit together or not at all.
- Values go in as bound parameters behind `?`, never pasted into the SQL.
- An administrator sets how large a database may grow. A write beyond that
  fails with `code_db_full`; the Code page shows storage used and the limit.
- A one-off `code_run` in a chat has no database.

Every Monday, this personal Code remembers how many tasks were open and tells
you the trend in your Gustav chat:

```ts
import { app, core, db, spaces } from "@sdk";

const SPACE_ID = "Spc001"; // fictional
const CHAT_ID = "Chat23"; // fictional

app.schedule({ cron: "0 8 * * 1", timeZone: "Europe/Berlin", name: "open-tasks" }, async ({ scheduledAt }) => {
  const week = (scheduledAt ?? new Date().toISOString()).slice(0, 10);
  const { data: open, page } = await spaces.task.list({ spaceId: SPACE_ID, status: "active", limit: 50 });

  await db.exec("CREATE TABLE IF NOT EXISTS weeks (week TEXT PRIMARY KEY, open INTEGER NOT NULL)");
  const [last] = await db.query<{ open: number }>(
    "SELECT open FROM weeks WHERE week < ? ORDER BY week DESC LIMIT 1", [week],
  );
  await db.exec(
    "INSERT INTO weeks(week, open) VALUES (?, ?) ON CONFLICT(week) DO UPDATE SET open = excluded.open",
    [week, open.length],
  );

  const count = `${open.length}${page?.hasMore ? "+" : ""}`;
  const text = last ? `Open tasks: ${count} (last week: ${last.open})` : `Open tasks: ${count}`;
  await core.ai.chat(CHAT_ID).deliver({ text, idempotencyKey: `open-tasks:${week}` });
});

export default app;
```

A retried Monday writes the same row again and delivers once.

Reference: [Database](/en/docs/platform/code-sdk#database).

## In this release

Included:

- schedules, manual runs and incoming mail events;
- routes and pages with key figures, charts, tables and forms, also public;
- webhooks as public routes, without a signature check;
- `core.ai.generate`, `core.ai.decide` and model loops with SDK tools and files;
- HTTPS requests to approved origins, with secrets as placeholders;
- files from one app to another as `FileRef`;
- a SQLite database of its own for every lasting Code;
- tests, simulation, `cld code` and the Gustav tools.

Not in this release:

- Actions that ask a person (send, delete, cannot undo, …) never run
  unattended. Code drafts a reply; a person sends it.
- Signature checks for incoming webhooks.
- A key-value store or file storage of its own, and state in memory between
  runs.

## Read on

- [Your first Code](/en/code/first-code): the project folder and the complete
  terminal flow.
- [Use cases and templates](/en/code/use-cases): mail, reports, pages, forms
  and AI loops to start from.
- [Find your API](/en/code/api): where your installation lists what Code can
  call, and how calls work.
- [Control and security](/en/code/control): approval, the execution owner,
  runtime checks and secrets.
