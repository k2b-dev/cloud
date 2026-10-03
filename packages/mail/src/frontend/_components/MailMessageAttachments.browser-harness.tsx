import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import MailMessageAttachments from "./MailMessageAttachments";

/** The real attachment list of a message; the test serves each attachment with invented demo content. */
export type MailAttachmentsHarnessAttachment = { id: string; filename: string; contentType: string; sizeBytes: number };

declare global {
  interface Window {
    mountAttachments: (attachments: MailAttachmentsHarnessAttachment[]) => void;
  }
}

window.mountAttachments = (attachments) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  render(
    () => (
      <LocaleProvider locale="en">
        <MailMessageAttachments mailboxId="Box001" messageId="Msg001" attachments={attachments} />
      </LocaleProvider>
    ),
    host,
  );
};
