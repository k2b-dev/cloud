import { Button, createCollectionSelection, DataTable, FileGrid, SegmentedControl } from "@k2b/ui";
import { createSignal, Match, Switch } from "solid-js";

const files = [
  { id: "reports", name: "Reports", icon: "ti ti-folder", meta: "" },
  { id: "notes", name: "Meeting notes.md", icon: "ti ti-file-text", meta: "4 KiB" },
  { id: "photo", name: "Team photo.jpg", icon: "ti ti-photo", meta: "2.1 MiB" },
  { id: "archive", name: "Archive.zip", icon: "ti ti-file-zip", meta: "Too large, up to 50 MiB" },
];
const tooLarge = (file: (typeof files)[number]) => file.id === "archive";
export function FileGridDemo() {
  const [view, setView] = createSignal("grid");
  const [opened, setOpened] = createSignal("");
  const selection = createCollectionSelection({ ids: () => files.map((file) => file.id) });
  // A picker: taps toggle, arrows only move focus, and the file that does not fit is not selectable.
  const choice = createCollectionSelection({ ids: () => files.filter((file) => !tooLarge(file)).map((file) => file.id), checklist: true });
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
            { value: "picker", label: "Picker" },
          ]}
        />
        <span role="status">
          {(view() === "picker" ? choice : selection).selected().size} selected{opened() ? ` · Opened: ${opened()}` : ""}
        </span>
        <Button size="sm" variant="secondary" onClick={() => (view() === "picker" ? choice : selection).clear()}>
          Clear selection
        </Button>
      </div>
      <Switch>
        <Match when={view() === "list"}>
          <DataTable
            rows={files}
            getRowId={(file) => file.id}
            selection={selection}
            columns={[{ id: "name", header: "Name", value: "name" }]}
            onRowDoubleClick={(file) => setOpened(file.name)}
          />
        </Match>
        <Match when={view() === "grid"}>
          <FileGrid
            rows={files}
            getRowId={(file) => file.id}
            selection={selection}
            label="Demo files"
            renderPreview={(file) => <i class={`${file.icon} text-3xl`} aria-hidden="true" />}
            renderLabel={(file) => file.name}
            onOpen={(file) => setOpened(file.name)}
          />
        </Match>
        <Match when={view() === "picker"}>
          <FileGrid
            rows={files}
            getRowId={(file) => file.id}
            selection={choice}
            label="Choose files"
            layout="list"
            isDisabled={tooLarge}
            renderPreview={(file) => (
              <i class={`${choice.selected().has(file.id) ? "ti ti-circle-check" : file.icon} text-xl`} aria-hidden="true" />
            )}
            renderLabel={(file) => file.name}
            renderMeta={(file) => file.meta}
            onOpen={(file) => setOpened(file.name)}
          />
        </Match>
      </Switch>
    </section>
  );
}
