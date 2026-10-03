import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { FileEntry } from "../contracts";
import { openFilePreview } from "./FilePreviewDialog";

/** Opens the real preview dialog from a browser test; the test serves every request with invented demo files. */
declare global {
  interface Window {
    preview: {
      open: (name: string, size: number, options?: { editable?: boolean; readOnly?: boolean }) => void;
      downloads: string[];
      edits: string[];
    };
  }
}

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      {(() => {
        window.preview = {
          downloads: [],
          edits: [],
          open: (name, size, options = {}) => {
            const entry: FileEntry = {
              name,
              path: `Summer party/${name}`,
              directory: false,
              size,
              modified: "2026-09-28T10:15:00.000Z",
              actions: { write: !options.readOnly, move: true, share: true },
            };
            void openFilePreview({
              baseId: "personal",
              entry,
              onDownload: () => window.preview.downloads.push(name),
              onEdit: options.editable ? () => window.preview.edits.push(name) : undefined,
              readOnly: options.readOnly,
            });
          },
        };
        return <button type="button">Open</button>;
      })()}
    </LocaleProvider>
  ),
  host,
);
