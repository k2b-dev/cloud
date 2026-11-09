# Template: mail invoices to an app

For each received message with an invoice attachment (PDF or XML), pass the
file to an import app as a FileRef and tag the conversation once the import
is done. The bytes never enter Code. The same example appears in Fibel
(`/en/docs/platform/code-sdk#mail-invoices-to-an-app`); CI keeps both copies identical.

Owner: the Code of a mailbox. Replace the fictional `imports` namespace and its
`import` Action with the destination app's write Action that `code_sdk` lists
(a write stream with a `file` input), and `Tag123` with a real tag ID of this
mailbox. The mailbox's service account needs **Edit** access to the mailbox and
the access the import requires at the destination. Attachment content is
untrusted; the receiving app validates it. See [FileRef](file-ref.md) for
expiry, single use and recovery.

<!-- code-file-example -->
<!-- check: resource mail.mailbox -->
```ts
import { app, mail, owner, imports } from "@sdk";

const importedTagId = "Tag123";

app.on("mail.message.received", async event => {
  let { data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true });
  while (message.hydrationStatus !== "complete") {
    ({ data: message } = await mail.message.read({ id: event.subject.id, waitForHydration: true }));
  }
  if (message.attachmentsTruncated) {
    throw new Error("Message attachments are not ready or complete");
  }
  const attachment = message.attachments.find(item =>
    ["application/pdf", "application/xml", "text/xml"].includes(item.contentType)
  );
  if (!attachment || !message.conversationId) return;

  const file = await mail.attachment.content.read({ id: attachment.id });
  await imports.import({
    file,
    idempotencyKey: `invoice:${event.data.receiptId}:${attachment.id}`,
  });
  const { data: conversation } = await mail.conversation.read({ id: message.conversationId });
  await owner.conversation.tag.update({
    conversationId: message.conversationId,
    expectedRevision: conversation.collaboration.revision,
    addTagIds: [importedTagId],
  });
});
export default app;
```
