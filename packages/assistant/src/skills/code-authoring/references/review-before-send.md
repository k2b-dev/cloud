# Review before sending

Use this pattern when a person wants a check before something leaves an app,
for example before a customer message goes out. It needs no special platform
feature: an app event, a rules note, one AI call and two Actions of the app.

The example uses a fictional app, **Outbox**. Its outgoing messages wait in an
outbox for a decision or for the app's time limit.

## Who does what

1. **The author** chooses Send. **The app** stores the message as *in review*
   with a new `revision` and raises an event, here `outbox.message.submitted`.
2. **Code** reacts with `app.on`. It reads the current rules, for example from
   a Notebooks note, so a changed note applies to the next message. It asks the
   model for `{ ok, reason, suggestion }`.
3. **Code** then calls exactly one of the app's Actions for that revision:
   - `message.approve({ id, revision })`: the app releases the message the
     author already chose to send.
   - `message.reject({ id, revision, reason, suggestion })`: the app opens the
     draft again and shows the reason and the suggestion.
4. **Access:** The outbox's manager shares the outbox with its Code account,
   and the rules note's manager shares the note (read). The app offers Code
   nothing else for messages: neither Action changes the text or sends a
   message the author did not send.

`approve` may run unattended because it starts no new effect: the person
already chose Send, and the Action only releases that message. An app that
lets Code send on its own, write text or choose recipients must declare that
Action as asking a person, and then this pattern does not apply.

`core.ai.decide` returns probabilities, not free text. A reason and a
suggestion need `core.ai.generate` with a JSON output schema
([AI](ai.md#extract-fields)).

## What the app decides itself

The app owns the gate, not the Code. Describe these to the person; Code does
not build them:

- A switch "Review on". Without a listening Code, the app sends at once.
- A time limit. When no decision arrives in time, the app sends anyway and
  writes a log entry. The app shows that log, so a failing review is visible.
- "Send anyway" with a reason for the author.
- Exactly one deciding Code per review point, and one decision per revision:
  the app accepts the first approve or reject for the current revision and
  refuses the rest.

## The Code

<!-- check: resource outbox.queue -->
```ts
import { app, core, notebooks, outbox } from "@sdk";

// Fictional rules note; its manager shares it with this outbox's Code account (read).
const RULES_NOTE = "Not001";

app.on("outbox.message.submitted", async event => {
  const { data: message } = await outbox.message.read({ id: event.subject.id });
  if (message.state !== "in_review") return;
  const { data: rules } = await notebooks.note.read({ id: RULES_NOTE });
  const { data: result } = await core.ai.generate({
    task: "outbox.review",
    prompt: "Check the outgoing message against the rules. ok is false only when a rule is broken. Name the rule in reason and propose a corrected text in suggestion.",
    input: { rules: rules.content, recipient: message.recipient, subject: message.subject, text: message.text },
    // Ask the operator which model class runs only on private models.
    model: { class: "balanced" },
    output: {
      type: "json",
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          reason: { type: "string", maxLength: 500 },
          suggestion: { type: "string", maxLength: 4000 },
        },
        required: ["ok", "reason", "suggestion"],
        additionalProperties: false,
      },
    },
  });
  const output = result.output;
  // Unclear model output decides nothing: the app's time limit takes over.
  if (typeof output !== "object" || output === null || !("ok" in output) || typeof output.ok !== "boolean") return;
  const decision = `${message.id}:${message.revision}`;
  if (output.ok) {
    await outbox.message.approve({ id: message.id, revision: message.revision, idempotencyKey: `approve:${decision}` });
    return;
  }
  const reason = "reason" in output && typeof output.reason === "string" ? output.reason.trim() : "";
  const suggestion = "suggestion" in output && typeof output.suggestion === "string" ? output.suggestion : "";
  if (!reason) return;
  await outbox.message.reject({ id: message.id, revision: message.revision, reason, suggestion, idempotencyKey: `reject:${decision}` });
});
export default app;
```

## Rules for this Code

- **When in doubt, do nothing.** A model error, a refusal, a timeout or
  missing access approves nothing and rejects nothing. Let the run fail or
  return; the app's time limit then decides and logs it.
- **Private models for customer data.** Customer messages go only to a model
  class that the operator runs on private models. Confirm with the operator
  that this class has no hosted fallback, and name it in `model: { class }`.
- **One decision per revision.** Each key names the Action, the message and its
  revision, so a retry repeats no effect and a resubmitted draft gets a new
  decision. The app still refuses a second decision for the same revision.
- **Test both ways** with fictional messages: one that passes and one that
  breaks a rule ([Tests and simulation](testing.md)).
