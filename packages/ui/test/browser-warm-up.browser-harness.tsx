import { Button, Combobox, Dropdown, dialogCore, NoticeCard, PanelDialog, panelDialogOptions, Tag } from "@k2b/ui";
import { render } from "solid-js/web";

const options = ["Ada Example", "Grace Example", "Linus Example"].map((label, index) => ({
  id: String(index),
  label,
  icon: "ti ti-user",
  description: "Person",
}));

render(
  () => (
    <Button
      variant="secondary"
      onClick={() =>
        void dialogCore.open<void>(
          (close) => (
            <PanelDialog>
              <PanelDialog.Header title="Warm-up" icon="ti ti-flame" close={() => close()} />
              <PanelDialog.Body>
                <div class="flex flex-col gap-4">
                  <NoticeCard tone="danger" title="Could not load">
                    <Button>Retry</Button>
                  </NoticeCard>
                  <Combobox
                    placeholder="Choose a person"
                    debounceMs={0}
                    fetchData={async (query) => options.filter((option) => option.label.toLowerCase().includes(query.toLowerCase()))}
                    onSelect={() => {}}
                  />
                  <Tag size="sm">Agent</Tag>
                  <Dropdown.Root
                    items={[
                      { label: "Rename", action: () => {} },
                      { label: "Remove", action: () => {} },
                    ]}
                  >
                    <Dropdown.Trigger label="More">More</Dropdown.Trigger>
                  </Dropdown.Root>
                </div>
              </PanelDialog.Body>
              <PanelDialog.Footer>
                <Button variant="secondary" onClick={() => close()}>
                  Close
                </Button>
              </PanelDialog.Footer>
            </PanelDialog>
          ),
          panelDialogOptions,
        )
      }
    >
      Open
    </Button>
  ),
  document.getElementById("root")!,
);
