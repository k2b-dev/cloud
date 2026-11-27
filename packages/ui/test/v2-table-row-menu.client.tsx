import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Button, Dialog, Menu, Pane, Table, Text, Workspace } from "../src/v2";

// A table whose rows open their detail (`?open=` in Mail, here `#open=` so the page stays), with a "…" menu at the end of
// each row whose item opens a dialog, as Mail's admin had it (#4324), and the same table inside a dialog, whose rows
// still open. What ran lands in `window.__deeds`.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    __deeds?: string[];
  }
}

const did = (deed: string) => {
  window.__deeds = [...(window.__deeds ?? []), deed];
};

type Box = { id: string; name: string };
const boxes: Box[] = [
  { id: "info", name: "info@werkstatt.example" },
  { id: "buero", name: "buero@werkstatt.example" },
];

const root = document.getElementById("root");
if (!root) throw new Error("table-row-menu: #root is missing");
render(() => {
  const [renaming, setRenaming] = createSignal<Box>();
  const [managing, setManaging] = createSignal(false);
  return (
    <Workspace>
      <Pane label="Postfächer">
        <Table
          label="Postfächer"
          rows={boxes}
          rowKey={(box) => box.id}
          open={(box) => ({ href: `#open=${box.id}` })}
          columns={[
            { title: "Postfach", width: { min: 200, default: 320 }, cell: (box) => box.name },
            {
              title: "",
              width: { min: 48, default: 48 },
              align: "end",
              cell: (box) => (
                <Menu
                  label={`Aktionen für ${box.name}`}
                  items={[
                    {
                      label: "Umbenennen",
                      icon: "pencil",
                      onClick: () => {
                        did(`rename:${box.id}`);
                        setRenaming(box);
                      },
                    },
                  ]}
                />
              ),
            },
          ]}
        />
        <Dialog
          title="Postfach umbenennen"
          open={renaming() !== undefined}
          onOpenChange={(open) => {
            if (!open) setRenaming(undefined);
          }}
          foot={<Button onClick={() => setRenaming(undefined)}>Fertig</Button>}
        >
          <Text>{renaming()?.name}</Text>
        </Dialog>
        {/* the same table inside a dialog: the dialog is around the whole table, so its rows open as anywhere */}
        <Button onClick={() => setManaging(true)}>Verwalten</Button>
        <Dialog
          title="Postfächer verwalten"
          open={managing()}
          onOpenChange={(open) => setManaging(open)}
          foot={<Button onClick={() => setManaging(false)}>Schließen</Button>}
        >
          <Table
            label="Postfächer im Dialog"
            rows={boxes}
            rowKey={(box) => box.id}
            open={(box) => ({ href: `#manage=${box.id}` })}
            columns={[{ title: "Postfach", width: { min: 200, default: 320 }, cell: (box) => box.name }]}
          />
        </Dialog>
      </Pane>
    </Workspace>
  );
}, root);
window.__k2Mounted = true;
