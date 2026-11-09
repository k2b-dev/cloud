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
| [Receive a webhook](#receive-a-webhook) | you or a mailbox | `app.post` with `{ public: true }`, `http.fetch` |
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

## Receive a webhook

A webhook is a public route that another service calls. In this release Cloud
does not verify a signature: anyone who knows the address can call it with
any content. So treat the request as a hint, never as a fact. Take only the ID
from it, ask the service's API for the real state with your secret, and act on
that answer. First ask, then act.

Code sees the method, the path, the query, the content type and the body of a
request, but no request headers. A webhook therefore arrives only with a JSON,
plain text or form body.

A fictional shipping service calls `/hooks/shipments` with a shipment ID.
When the service confirms the delivery, the Code files one Space task:

```ts
import { app, http, secrets, spaces } from "@sdk";

const space = spaces.space("Spc001"); // fictional
const teamGroupIds = ["grp_team"]; // fictional
const text = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));

// The access check covers /team only, so /hooks stays reachable.
app.use("/team", async (c, next) => {
  if (!c.user || !c.user.groupIds.some((id) => teamGroupIds.includes(id))) return c.text("Only for the team.", 403);
  return next();
});

app.post("/hooks/shipments", async (c) => {
  // Anyone can send this. Take only the ID, and only in a known shape.
  const body: unknown = await c.req.json();
  const id = body && typeof body === "object" && "shipmentId" in body ? body.shipmentId : null;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return c.json({ ok: false }, 400);

  // Ask the service itself; the body may be made up.
  const response = await http.fetch(`https://api.shipping.example/v1/shipments/${id}`, {
    headers: { authorization: `Bearer ${secrets.SHIPPING}` },
  });
  if (response.status === 404) return c.json({ ok: true }); // unknown shipment: nothing to do
  if (response.status !== 200) return c.json({ ok: false }, 502);
  const shipment: unknown = JSON.parse(text(response.body));
  const delivered = shipment && typeof shipment === "object" && "status" in shipment && shipment.status === "delivered";
  if (!delivered) return c.json({ ok: true });

  await space.task.create({ title: `Unpack shipment ${id}`, idempotencyKey: `shipment-delivered:${id}` });
  return c.json({ ok: true });
}, { public: true });

export default app;
```

Why this stays safe without a signature:

- A made-up call can only make the Code ask the service. The Code acts only
  on what the service itself answers, with your secret.
- The idempotency key turns repeated calls into one task.
- If your access check runs for every route, it must let the webhook path
  through. A private prefix such as `/team`, as above, does that.

A public request body has at most 4 KiB. The route answers within 8 seconds,
and public routes share a limit of 20 requests per minute per client network
and per Code. With the default policy, the public route and the
internet origin need an administrator's approval. This release has no
signature check for incoming requests.

Reference: [Serve routes](/en/docs/platform/code-sdk#serve-routes),
[Code secrets](/en/docs/platform/code-secrets).

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
