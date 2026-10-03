import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import AttachmentsOverview from "../[id]/_components/attachments-overview/AttachmentsOverview.island";
import type { Attachment } from "../[id]/_components/editor/attachments-client";

/** The real attachments overview; the test serves each attachment with invented demo content. */
declare global {
  interface Window {
    mountAttachments: (attachments: Attachment[], locale: string) => void;
  }
}

window.mountAttachments = (attachments, locale) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = locale;
  render(
    () => (
      <LocaleProvider locale={locale}>
        <AttachmentsOverview notebookId="nb0001" initial={attachments} searchQuery="" />
      </LocaleProvider>
    ),
    host,
  );
};
