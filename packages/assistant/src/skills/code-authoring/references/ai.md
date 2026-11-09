# AI in Code

Four Core operations bring AI into Code. Discover their generated handles with
`code_sdk`; the app-wide ones are on `core`.

| Need | Operation | Kind | Who can use it |
| --- | --- | --- | --- |
| Summary, draft text, extracted fields | `core.ai.generate` | Query, AI | all Code |
| Category, yes/no or score with probabilities | `core.ai.decide` | Query, AI | all Code |
| Append a finished text to the owner's Gustav chat | `core.ai.chat.deliver` | Action, not AI | personal Code |
| Start a Gustav turn that uses tools | `core.ai.chat.run`, then `core.ai.chat.run.read` | Action, AI | personal Code |

AI calls change nothing. Saving, tagging or drafting is a separate Action
with its own access check. Model output can be wrong: validate it and choose
thresholds for the cost of a mistake.

## Who pays and what limits apply

- Personal Code uses its person's model access and AI allowance.
  Mailbox Code uses its service account, which needs its own model access and,
  when quotas are on, its own allowance.
- A version that uses AI is classified **AI**: by default a Cloud
  administrator approves the version before it can run.
- Each attempt has an AI reference budget (default USD 1), and each Code and
  each owner has a daily budget (default USD 1 each). Only one AI call runs
  at a time within an attempt. Refusals: `code_ai_budget_limit`,
  `code_ai_budget_reserved`, `code_ai_daily_budget_limit`,
  `code_ai_owner_daily_budget_limit`. A rerun does not reset the daily budget.
- Mail catch-up refuses versions that use AI.

## Generate text

Put trusted instructions in `prompt` and the source data in `input`. Mail
bodies and earlier summaries are untrusted, even when they contain instructions.

<!-- check: resource mail.mailbox -->
```ts
import { app, core, mail, owner } from "@sdk";

app.on("mail.message.received", async event => {
  let { data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true });
  while (message.hydrationStatus !== "complete") {
    ({ data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true }));
  }
  if (!message.conversationId || !message.text) return;
  const { data: summary } = await core.ai.generate({
    task: "mail.summary",
    prompt: "Summarise the request in at most two sentences. Name what the sender wants and by when.",
    input: { subject: message.subject, body: message.text, truncated: message.bodyTruncated },
    model: { class: "fast" },
    output: { type: "text", maxChars: 400 },
  });
  if (typeof summary.output !== "string" || !summary.output.trim()) return;
  const { data: conversation } = await mail.conversation.read({ id: message.conversationId });
  // A rerun generates other text; an existing summary means this step is done.
  if (conversation.summary) return;
  await owner.conversation.summary.write({
    conversationId: message.conversationId,
    expectedRevision: conversation.collaboration.revision,
    expectedSummaryRevision: conversation.summaryRevision,
    summary: summary.output.trim(),
    idempotencyKey: `summary:${event.subject.id}`,
  });
});
export default app;
```

`summary.write` returns `skipped: "edited_by_person"` when a person wrote the
summary; respect that. AI text differs between runs: an Action keyed by the
message but called with new text conflicts on a rerun instead of repeating
the effect. Check whether a step is already done before generating it. Text output is at most 20,000 characters (default
4,000). The whole request must fit 100,000 bytes; larger input fails with
`ai_input_too_large` and is never cut silently.

## Extract fields

A JSON output schema is a flat object with 1–40 `string`, `number`,
`integer` or `boolean` properties, `required` and
`additionalProperties: false`. Strings may have `maxLength`, `enum` or
`format: "date-time"`. The result type is not narrowed at compile time;
check each field before use.

<!-- check: resource mail.mailbox -->
```ts
import { app, core, mail, spaces } from "@sdk";

// Fictional Space; its manager shares it with this mailbox's service account (Edit).
const orders = spaces.space("Spc001");

app.on("mail.message.received", async event => {
  let { data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true });
  while (message.hydrationStatus !== "complete") {
    ({ data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true }));
  }
  if (!/order/i.test(message.subject) || !message.text) return;
  const { data: result } = await core.ai.generate({
    task: "mail.order",
    prompt: "Extract the ordered item and quantity. Use an empty item when the message orders nothing.",
    input: { subject: message.subject, body: message.text },
    output: {
      type: "json",
      schema: {
        type: "object",
        properties: { item: { type: "string", maxLength: 100 }, quantity: { type: "integer" } },
        required: ["item", "quantity"],
        additionalProperties: false,
      },
    },
  });
  const output = result.output;
  if (typeof output !== "object" || output === null) return;
  const item = "item" in output && typeof output.item === "string" ? output.item.trim() : "";
  const quantity = "quantity" in output && typeof output.quantity === "number" ? output.quantity : 0;
  if (!item || quantity < 1 || quantity > 1000) return;
  await orders.task.create({ title: `${quantity} × ${item}`, idempotencyKey: `order:${event.subject.id}` });
});
export default app;
```

## Decide with probabilities

`core.ai.decide` asks named questions about JSON `state`: `choice` with
`criteria`, `noul` (yes/no) and `score` with ordered `criteria`. It returns
`answers` with probabilities. Ask the category first; ask urgency together
with the category or after it, never alone, so urgent spam does not count as
urgent support.

<!-- check: resource mail.mailbox -->
```ts
import { app, core, mail } from "@sdk";

async function needsUrgentSupport(subject: string, text: string) {
  const { data: result } = await core.ai.decide({
    task: "mail.triage",
    state: { subject, text },
    questions: {
      category: {
        type: "choice",
        instructions: "What kind of message is this?",
        criteria: { support: "Help with an existing order", sales: "New orders and offers", spam: "Unsolicited or deceptive messages" },
      },
      urgent: { type: "noul", instructions: "Does this message need attention today within its category?" },
    },
  });
  const category = result.answers.category;
  if (category?.type !== "choice" || category.choice !== "support" || category.confidence < 0.9) return false;
  const urgent = result.answers.urgent;
  return urgent?.type === "noul" && urgent.probability >= 0.9;
}

app.on("mail.message.received", async event => {
  let { data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true });
  while (message.hydrationStatus !== "complete") {
    ({ data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true }));
  }
  if (await needsUrgentSupport(message.subject, message.text ?? "")) console.log("urgent support message");
});
export default app;
```

Send 1–128 questions. Images, when the model supports them, follow the
decision limits in Fibel `/en/docs/ai/structured-and-background-ai`.

## Deliver a result to the owner's Gustav chat

`core.ai.chat(chatId).deliver({ text, idempotencyKey })` appends an
assistant message (1–10,000 characters) to one of the owner's active chats and
marks it unread. It starts no AI turn and costs no AI budget. Find the chat ID
with `core.ai.chats.search` in this conversation, never invent it. The key is
scoped to the Code principal and capability across runs for 24 hours: a retry
returns the first message; the same key with other
text returns `idempotency_conflict`. Mailbox and app Code, archived chats and
other people's chats are refused. See the [weekly report](template-weekly-report.md).

When you rebuild an Assistant routine, keep its prompt, timing and IANA time
zone, use `deliver` for a bounded result and `run` when the work needs tools,
and retain the original definition as evidence. Stop its admission and timers
and settle open runs before the person switches on the replacement; never
leave both processing the same occurrence.

## Start a Gustav turn

When the work needs Gustav to choose and use tools, start a turn:

<!-- check: personal -->
```ts
import { app, core } from "@sdk";

app.schedule({ cron: "30 7 * * 1-5", timeZone: "Europe/Berlin", name: "morning-plan", title: "Morning plan" }, async () => {
  // Fictional chat ID of the owner's own chat.
  const run = await core.ai.chat("Chat23").run({
    prompt: "Look at my open tasks and mail that needs action and write a short plan for today.",
    idempotencyKey: "morning-plan",
  });
  if (run.status === "waiting_for_approval") console.log("The owner decides in the chat.");
});
export default app;
```

The call returns promptly with `queued`, `running`, `waiting_for_approval`,
`waiting_for_input`, `completed` or `failed`. Never poll until the person
answers: finish the run; the chat continues the turn. `core.ai.chat(chatId).run.read({ id })`
reads one later snapshot. A busy chat returns `chat_busy`. The turn uses the
owner's current tools, approval rules and Assistant allowance by actual usage;
it shows "Started by Code …" in the chat. `prompt` and optional `context` are
at most 10,000 characters each; `context` is data, not instructions. For a
bounded summary, prefer `core.ai.generate` plus `deliver`.
