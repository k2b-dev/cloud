import type { MailDraftDocumentClient } from "../../lib/draft-document-client";

/** The whole shared draft as plain text, for the clipboard: recipients, subject, and body, or the rejected proposal. */
export const copySharedDraft = async (client: MailDraftDocumentClient): Promise<void> => {
  const content = client.state().rejectedEdit ?? client.content();
  await navigator.clipboard.writeText(
    `${content.to.map((entry) => entry.address).join(", ")}\nCc: ${content.cc.map((entry) => entry.address).join(", ")}\nBcc: ${content.bcc.map((entry) => entry.address).join(", ")}\n${content.subject}\n\n${content.body}`,
  );
};
