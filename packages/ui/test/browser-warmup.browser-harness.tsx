import { render } from "solid-js/web";
import {
  Button,
  Combobox,
  dialogCore,
  LocaleProvider,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  RemoveButton,
  Tag,
} from "../src";

const root = document.getElementById("root");
if (!root) throw new Error("Warm-up root missing");

/** The surfaces most browser tests draw first: an animated panel dialog with its feedback and a list over it. */
const open = () =>
  void dialogCore.open<void>(
    (close) => (
      <PanelDialog>
        <PanelDialog.Header title="Warm-up" icon="ti ti-flame" close={() => close()} />
        <PanelDialog.Body>
          <Combobox
            placeholder="Search"
            fetchData={async () => [{ id: "one", label: "Option", icon: "ti ti-robot", description: "Description" }]}
            onSelect={() => {}}
          />
          <NoticeCard tone="danger" title="Notice">
            <Button>Retry</Button>
          </NoticeCard>
          <Placeholder state="loading" title="Loading" />
          <Tag size="sm">Tag</Tag>
          <RemoveButton ariaLabel="Remove" onClick={() => {}} />
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Button variant="secondary" onClick={() => close()}>
            Done
          </Button>
        </PanelDialog.Footer>
      </PanelDialog>
    ),
    panelDialogOptions,
  );

render(
  () => (
    <LocaleProvider locale="en">
      <Button variant="secondary" onClick={open}>
        Open
      </Button>
    </LocaleProvider>
  ),
  root,
);
