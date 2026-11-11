import { createCollectionSelection, LocaleProvider } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { FileEntry } from "../contracts";
import FileList from "./FileList";
import FilePreview from "./FilePreview";
import FileQuickView from "./FileQuickView";

/** Opens the real quick view from a browser test; the test serves every request with invented demo files. */
declare global {
  interface Window {
    preview: {
      /** Opens the quick view on this file of the folder; `editable` names files that open an editor. */
      open: (name: string, options?: { editable?: string[] }) => void;
      /** Shows the file as a folder's README, in the viewport the file browser gives it. */
      readme: (name: string) => void;
      /** Shows the folder as the file list, with every file's preview in its icon's place. */
      list: () => void;
      downloads: string[];
      edits: string[];
      shares: string[];
      steps: string[];
      closed: number;
    };
    folder: { name: string; size: number }[];
  }
}

const file = (name: string, size: number): FileEntry => ({
  name,
  path: `Summer party/${name}`,
  directory: false,
  size,
  modified: "2026-09-28T10:15:00.000Z",
  revision: `r-${name}`,
  actions: { write: true, move: true, share: true },
});
const [current, setCurrent] = createSignal<string | null>(null);
const [editable, setEditable] = createSignal<string[]>([]);
const [readme, setReadme] = createSignal<FileEntry | null>(null);
const [list, setList] = createSignal(false);
const entries = () => window.folder.map((item) => file(item.name, item.size));

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      {(() => {
        window.preview = {
          downloads: [],
          edits: [],
          shares: [],
          steps: [],
          closed: 0,
          open: (name, options = {}) => {
            setEditable(options.editable ?? []);
            setCurrent(`Summer party/${name}`);
          },
          readme: (name) => setReadme(entries().find((entry) => entry.name === name) ?? null),
          list: () => setList(true),
        };
        return <button type="button">Open</button>;
      })()}
      <Show when={current()}>
        {(path) => (
          <FileQuickView
            baseId="personal"
            entries={entries()}
            current={path()}
            onCurrentChange={(next) => {
              window.preview.steps.push(next.split("/").at(-1)!);
              setCurrent(next);
            }}
            onClose={() => {
              window.preview.closed++;
              setCurrent(null);
            }}
            onDownload={(entry) => window.preview.downloads.push(entry.name)}
            onShare={(entry) => window.preview.shares.push(entry.name)}
            editable={(entry) => editable().includes(entry.name)}
            onEdit={(entry) => {
              window.preview.edits.push(entry.name);
              setCurrent(null);
            }}
          />
        )}
      </Show>
      <Show when={list()}>
        {(() => {
          const selection = createCollectionSelection({ ids: () => entries().map((entry) => entry.path) });
          return (
            <div class="filesv2-browser">
              <FileList
                baseId="personal"
                rows={entries()}
                selection={selection}
                label="Files"
                showModified
                messages={{
                  name: "Name",
                  size: "Size",
                  modified: "Modified",
                  details: (name) => `Details for ${name}`,
                  toggle: (name) => `Toggle ${name}`,
                  select: (name) => `Select ${name}`,
                  more: "More",
                }}
                onOpen={(row) => setCurrent(row.path)}
                onDetails={() => {}}
              />
            </div>
          );
        })()}
      </Show>
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
