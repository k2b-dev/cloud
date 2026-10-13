import { Button, createCollectionSelection, LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { browserMessages } from "./browser-messages";
import FileList from "./FileList";
import { filesMessages } from "./messages";

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
render(() => {
  const locale = document.documentElement.lang || "en";
  const b = browserMessages.resolve([locale]).t;
  const t = filesMessages.resolve([locale]).t;
  const [selecting, setSelecting] = createSignal(false);
  const rows = ["Projects", "Reports", "Archive"].map((name) => ({
    name,
    path: name,
    directory: true,
    size: 0,
    modified: "2026-10-01T00:00:00Z",
  }));
  const selection = createCollectionSelection({ ids: () => rows.map((row) => row.path) });
  const parent = "Projects / " + "Very long parent folder name with many words / ".repeat(24);
  return (
    <LocaleProvider locale={locale}>
      <Button onClick={() => setSelecting(true)}>{b.select}</Button>
      {/* The browser is the container whose width hides the date and size columns. */}
      <div class="filesv2-browser">
        <FileList
          baseId="home"
          rows={rows}
          selection={selection}
          label="Files"
          showModified
          selecting={selecting()}
          before={[
            {
              key: "up",
              label: b.parentRow,
              detail: parent,
              ariaLabel: b.parentFolderUp(parent),
              icon: "ti ti-folder-up",
              onClick: () => {},
            },
          ]}
          messages={{
            name: t.name,
            size: t.size,
            modified: t.modified,
            details: b.detailsFor,
            toggle: b.toggleFolder,
            select: b.selectEntry,
            more: b.more,
          }}
          onOpen={() => {}}
          onDetails={() => {}}
        />
      </div>
    </LocaleProvider>
  );
}, host);
