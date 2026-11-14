import { createCollectionSelection, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { FileEntry } from "../contracts";
import FileList from "./FileList";

/** The file list of one invented folder, with every file's preview in its icon's place; the test serves the previews. */
declare global {
  interface Window {
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

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(() => {
  const entries = window.folder.map((item) => file(item.name, item.size));
  const selection = createCollectionSelection({ ids: () => entries.map((entry) => entry.path) });
  return (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <div class="filesv2-browser">
        <FileList
          baseId="personal"
          rows={entries}
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
          onOpen={() => {}}
          onDetails={() => {}}
        />
      </div>
    </LocaleProvider>
  );
}, host);
