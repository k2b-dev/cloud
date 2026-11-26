import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { Attachment } from "../[id]/_components/editor/attachments-client";
import PreviewTiles from "./attachment-preview.test-host";

/** One button per attachment that opens it as a row of the attachments page does; the test serves invented demo content. */
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
        <PreviewTiles notebookId="nb0001" attachments={attachments} />
      </LocaleProvider>
    ),
    host,
  );
};
