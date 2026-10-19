import { DataTable, prompts, SettingsModal } from "@k2b/ui";
import { render } from "solid-js/web";

const host = document.createElement("div");
document.querySelector(".cloud-app-canvas")!.append(host);

const SelectedTable = () => (
  <DataTable
    rows={[{ id: "selected", name: "Selected file" }]}
    columns={[{ id: "name", header: "Name", value: "name" }]}
    getRowId={(row) => row.id}
    selectedRowId="selected"
    surface="plain"
  />
);

render(
  () => (
    <button
      type="button"
      onClick={() =>
        void prompts.dialog<void>(
          (close) => (
            <div class="dialog-fixed-frame flex min-h-0 flex-col overflow-hidden">
              <SettingsModal title="App settings" onClose={() => close()}>
                <SettingsModal.Tab id="general" title="General">
                  <SelectedTable />
                </SettingsModal.Tab>
                <SettingsModal.Tab id="files" title="Files">
                  <SelectedTable />
                </SettingsModal.Tab>
              </SettingsModal>
            </div>
          ),
          { surface: "bare", header: false, size: "large" },
        )
      }
    >
      Open app settings
    </button>
  ),
  host,
);
