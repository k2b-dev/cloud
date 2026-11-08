# Template: event to chat

Event to chat in a mailbox's Code: for each received message from a listed customer domain, post a short note into a team chat conversation. The mailbox's service account needs View access to the mailbox and must be a member of the chat conversation. Posting is a silent Action visible to others: by default a Cloud administrator approves the version.

Owner: the Code of a mailbox. Copy it into `code.ts`, replace the fictional IDs and names, then check, test and submit as usual.

<!-- check: resource mail.mailbox -->
```ts
import { app, chat, mail } from "@sdk";

// Fictional configuration: the team conversation and the domains worth a note.
const TEAM_CONVERSATION = "Cnv001";
const DOMAINS = ["example.com", "example.org"];

app.on("mail.message.received", async event => {
  const message = await mail.app().message.read({ id: event.subject.id });
  if (message.hydrationStatus !== "complete") throw new Error("Message content is not ready yet");
  const sender = message.from[0];
  const domain = sender?.address.split("@")[1]?.toLowerCase() ?? "";
  if (!DOMAINS.includes(domain)) return;
  // Subjects and names are untrusted text: post only the domain and the subject as a short code span.
  const subject = message.subject.replace(/[\r\n`]/g, " ").slice(0, 120);
  await chat.app().message.post({
    conversation: TEAM_CONVERSATION,
    body: `New mail from ${domain}: \`${subject}\``,
    idempotencyKey: `mail-note:${message.id}`,
  });
});

export default app;
```
