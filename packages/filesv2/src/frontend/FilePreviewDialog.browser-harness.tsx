import { LocaleProvider } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { FileEntry } from "../contracts";
import FilePreview from "./FilePreview";
import { openFilePreview } from "./FilePreviewDialog";

/** Opens the real preview dialog from a browser test; the test serves every request with invented demo files. */
declare global {
  interface Window {
    preview: {
      open: (name: string, size: number, options?: { editable?: boolean; readOnly?: boolean }) => void;
      /** Shows the file as a folder's README, in the viewport the file browser gives it. */
      readme: (name: string, size: number) => void;
      downloads: string[];
      edits: string[];
    };
  }
}

const file = (name: string, size: number, options: { readOnly?: boolean } = {}): FileEntry => ({
  name,
  path: `Summer party/${name}`,
  directory: false,
  size,
  modified: "2026-09-28T10:15:00.000Z",
  actions: { write: !options.readOnly, move: true, share: true },
});
const [readme, setReadme] = createSignal<FileEntry | null>(null);

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
            void openFilePreview({
              baseId: "personal",
              entry: file(name, size, options),
              onDownload: () => window.preview.downloads.push(name),
              onEdit: options.editable ? () => window.preview.edits.push(name) : undefined,
              readOnly: options.readOnly,
            });
          },
          readme: (name, size) => setReadme(file(name, size)),
        };
        return <button type="button">Open</button>;
      })()}
      <Show when={readme()}>
        {(entry) => (
          // The folder README of `Browser.tsx`.
          <section class="filesv2-folder-readme">
            <div class="filesv2-folder-readme__content">
              <div>
                <FilePreview baseId="personal" entry={entry()} headingScale="compact" variant="plain" onDownload={() => {}} />
              </div>
            </div>
          </section>
        )}
      </Show>
    </LocaleProvider>
  ),
  host,
);
