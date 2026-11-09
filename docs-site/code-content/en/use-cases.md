---
title: Use cases and templates
navTitle: Use cases
section: Guides
order: 30
description: Five things to build with feat/code, from mail sorting to AI loops that read invoices, each with the code to start from.
tags: [code, templates, examples, automation, ai]
updated: 2026-11-09
---

# Use cases and templates

Each example below is real Code against the built-in apps. IDs, names and
mailboxes are fictional; read the real IDs through the SDK. Gustav knows
complete, checked templates for each case: ask it for "a weekly report into my
chat" or "a form that files a Space task", and it starts from the template.

| You want to … | Owner | Starts from |
| --- | --- | --- |
| [Sort and summarise incoming mail](#sort-and-summarise-incoming-mail) | mailbox | `app.on("mail.message.received")` |
| [Get a Monday report in your Gustav chat](#get-a-monday-report-in-your-gustav-chat) | you | `app.schedule` |
| [Give a team a form that files tasks](#give-a-team-a-form-that-files-tasks) | you or a mailbox | `app.use`, `app.get`, `app.post` |
| [Hand out a public survey](#hand-out-a-public-survey) | you | `{ public: true, layout: "plain" }` |
| [Let AI read invoice attachments](#let-ai-read-invoice-attachments) | mailbox | `core.ai.generate` with `files` and `tools` |

## Sort and summarise incoming mail

Mailbox Code reacts to every new message: classify it with `core.ai.decide`,
then tag, assign, set a status or write a summary through Mail's Actions. The
[overview example](/en/code#see-it) tags invoices. The complete Gustav template
also assigns support mail and writes a two-sentence summary.

Code drafts; people send. Sending is an Action that asks a person, and those
never run unattended in this release.

Reference: [Automate incoming mail with Code](/en/docs/platform/mail-code-automations),
including how to preview one real message without effects and catch up older mail.

## Get a Monday report in your Gustav chat

Personal Code runs as you. Every Monday at 08:00 Berlin time it reads overdue
tasks of a Space, asks AI for a short report and delivers it into one of your
Gustav chats:

```ts
import { app, core, spaces } from "@sdk";

const SPACE_ID = "Spc001"; // fictional
const CHAT_ID = "Chat23"; // fictional

app.schedule({ cron: "0 8 * * 1", timeZone: "Europe/Berlin", name: "weekly-report", title: "Weekly report" },
  async ({ runId, scheduledAt }) => {
    const { data: overdue, page } = await spaces.task.list({
      spaceId: SPACE_ID, status: "active", deadlineFilter: "overdue", limit: 50,
    });
    const { data: report } = await core.ai.generate({
      task: "weekly.report",
      prompt: "Write a short weekly report about these overdue tasks. Use only the given facts.",
      input: { titles: overdue.map((task) => task.title).slice(0, 20), incomplete: page?.hasMore ?? false },
      model: { class: "fast" },
      output: { type: "text", maxChars: 3000 },
    });
    const text = typeof report.output === "string" && report.output.trim() ? report.output.trim() : "No report this week.";
    await core.ai.chat(CHAT_ID).deliver({ text, idempotencyKey: `weekly-report:${scheduledAt ?? runId}` });
  });

export default app;
```

The key uses `scheduledAt`, so a retried Monday never delivers twice.
`cld code run weekly-report` starts it by hand.

Reference: [Schedules](/en/docs/platform/code-sdk#schedule-a-recurring-local-time),
[Deliver a result to your Gustav chat](/en/docs/platform/code-sdk#deliver-a-result-to-your-gustav-chat).

## Give a team a form that files tasks

Code pages are built from Cloud's own blocks: key figures, charts, tables,
details and forms. Cloud draws them in light and dark, on phones, and without
JavaScript. Every signed-in person can open a non-public route, so the Code
decides who may use it. Here one middleware admits a workshop group for every
route:

```tsx
import { app, Field, Form, jsx, Notice, Page, spaces } from "@sdk";

const space = spaces.space("Spc001"); // fictional
const workshopGroupIds = ["grp_workshop"]; // fictional

app.use(async (c, next) => {
  if (!c.user || !c.user.groupIds.some((id) => workshopGroupIds.includes(id)))
    return c.text("Only for the workshop team.", 403);
  return next();
});

const requestForm = (token: string, title = "", error?: string) => (
  <Page title="Repair request" icon="ti ti-tool" color="blue">
    <Form title="What needs fixing?" action={`/request/${token}`} submit="File request">
      <Field.Text name="title" label="Item and problem" value={title} error={error} required />
    </Form>
  </Page>
);

app.get("/", (c) => c.page(requestForm(crypto.randomUUID())));

app.post("/request/:token", async (c) => {
  const token = c.req.param("token");
  const title = String((await c.req.formData()).get("title") ?? "").trim();
  if (!title || title.length > 200) return c.page(requestForm(token, title, "Describe it in up to 200 characters."));
  await space.task.create({ title, idempotencyKey: `repair:${token}` });
  return c.page(
    <Page title="Repair request" icon="ti ti-tool" color="blue">
      <Notice tone="success" title="Request filed" text="The workshop sees it in its Space." />
    </Page>,
  );
});

export default app;
```

The page lives at `/code/<id>/`. A form keeps its input when something fails,
and Cloud never repeats a POST on its own. The token in the address makes a
repeated submit file one task, not two.

Reference: [Return a page](/en/docs/platform/code-sdk#return-a-page),
[Middleware and access checks](/en/docs/platform/code-sdk#zugriff-prufen).

## Hand out a public survey

A route with `{ public: true, layout: "plain" }` opens without sign-in and
without the Cloud layout, like a form you hand out:

```tsx
app.get("/", (c) => c.page(survey()), { public: true, layout: "plain" });
```

A public route has no visitor (`c.user` is always `null`), so it checks
something else, such as a closing date. Public routes need the administrator's
approval by default, and every Code page carries a **Made with feat/code** label
that warns never to enter passwords.

Reference: the complete survey in [Where a page appears](/en/docs/platform/code-sdk#where-a-page-appears).

## Let AI read invoice attachments

This is a model loop. Mailbox Code passes a PDF attachment to the model as a
file and hands it one tool: search this mailbox. The model reads the invoice,
checks for earlier messages from the same supplier and returns structured
lines:

```ts
import { app, core, mail, owner } from "@sdk";

app.on("mail.message.received", async (event) => {
  let { data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true });
  while (message.hydrationStatus !== "complete") {
    ({ data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true }));
  }
  const pdf = message.attachments.find((item) => item.contentType === "application/pdf");
  if (!pdf) return;

  const file = await mail.attachment.content.read({ id: pdf.id });
  const { data: result } = await core.ai.generate({
    task: "invoice.lines",
    prompt: "Read the invoice. Search this mailbox for earlier messages from the supplier. " +
      "Return the invoice number and its lines. Use only values printed on the invoice.",
    input: { subject: message.subject },
    files: [file],
    tools: [owner.conversation.search],
    output: { type: "json", schema: {
      type: "object", additionalProperties: false, required: ["number", "lines"],
      properties: {
        number: { type: "string", maxLength: 64 },
        lines: { type: "array", maxItems: 100, items: {
          type: "object", additionalProperties: false, required: ["label", "grossCents"],
          properties: { label: { type: "string", maxLength: 200 }, grossCents: { type: "integer" } },
        } },
      },
    } },
  });
  // Validate result.output, then pass it to an Action of the app that owns invoices.
});

export default app;
```

The bytes never enter the Code: `FileRef` is an opaque, single-use reference.
Each tool call is an ordinary SDK call of the mailbox's account, checked and
logged like any other. The tool is bound to this mailbox, so the model cannot
search another one. What happens with the result, a stored value or a
suggestion, is the decision of the app whose Action receives it.

Reference: [Run a model loop with SDK tools and files](/en/docs/platform/code-sdk#run-a-model-loop-with-sdk-tools-and-files),
[Mail invoices to an app](/en/docs/platform/code-sdk#mail-invoices-to-an-app).

## More to call

Every app that publishes capabilities is reachable the same way: Grids tables,
Spaces tasks, chat messages, files, contacts, and the apps your organisation
adds. [Find your API](/en/code/api) shows where your installation lists them.
