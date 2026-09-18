import { Button, createCollectionSelection, DataTable, FileGrid, SegmentedControl } from "@k2b/ui";
import { createSignal, Show } from "solid-js";

const files = [
  { id: "reports", name: "Reports", icon: "ti ti-folder" },
  { id: "notes", name: "Meeting notes.md", icon: "ti ti-file-text" },
  { id: "photo", name: "Team photo.jpg", icon: "ti ti-photo" },
];
export function FileGridDemo() {
  const [view, setView] = createSignal("grid");
  const [opened, setOpened] = createSignal("");
  const selection = createCollectionSelection({ ids: () => files.map((file) => file.id) });
  return (
    <section class="flex flex-col gap-3" aria-label="Shared list and grid selection">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          value={view()}
          onValueChange={setView}
          label="View"
          options={[
            { value: "list", label: "List" },
            { value: "grid", label: "Grid" },
          ]}
        />
        <span role="status">
          {selection.selected().size} selected{opened() ? ` · Opened: ${opened()}` : ""}
        </span>
        <Button size="sm" variant="secondary" onClick={selection.clear}>
          Clear selection
        </Button>
      </div>
      <Show
        when={view() === "grid"}
        fallback={
          <DataTable
            rows={files}
            getRowId={(file) => file.id}
            selection={selection}
            columns={[{ id: "name", header: "Name", value: "name" }]}
            onRowDoubleClick={(file) => setOpened(file.name)}
          />
        }
      >
        <FileGrid
          rows={files}
          getRowId={(file) => file.id}
          selection={selection}
          label="Demo files"
          renderPreview={(file) => <i class={`${file.icon} text-3xl`} aria-hidden="true" />}
          renderLabel={(file) => file.name}
          onOpen={(file) => setOpened(file.name)}
        />
      </Show>
    </section>
  );
}
