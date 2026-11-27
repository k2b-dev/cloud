import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Button, Dialog, Menu, Table } from "../src/v2";

// Mail's repro (#4324): a menu in a table row whose first cell links to the row's page. Picking an item of that
// menu should run the item (here: open a dialog), as it does in the same table without a link. `?open=1` names the
// linked table.

declare global {
  interface Window {
    __k2Mounted?: boolean;
    /** The items that ran, in order. */
    __k2Picked?: string[];
  }
}

type Rule = { id: string; value: string };
const rules: readonly Rule[] = [
  { id: "r1", value: "phish.example.org" },
  { id: "r2", value: "spam.example.org" },
];

const Screen = () => {
  const linked = new URLSearchParams(location.search).get("open") === "1";
  const [asking, setAsking] = createSignal<string>();
  const pick = (row: Rule) => {
    window.__k2Picked = [...(window.__k2Picked ?? []), row.id];
    setAsking(row.value);
  };
  return (
    <>
      <Table
        label="Regeln"
        rows={rules}
        rowKey={(row) => row.id}
        // the only difference between the two tables: the row opens its page
        {...(linked ? { open: (row: Rule) => ({ href: `#detail-${row.id}` }) } : {})}
        columns={[
          { title: "Wert", width: { min: 200, default: 260 }, cell: (row) => row.value },
          {
            title: "Aktionen",
            width: { min: 88, default: 88 },
            align: "end",
            cell: (row) => (
              <Menu label={`Aktionen für ${row.value}`} items={[{ label: "Löschen", icon: "trash", onClick: () => pick(row) }]} />
            ),
          },
        ]}
      />
      <Dialog
        title="Regel löschen?"
        open={asking() !== undefined}
        onOpenChange={(open) => {
          if (!open) setAsking(undefined);
        }}
        foot={<Button onClick={() => setAsking(undefined)}>Abbrechen</Button>}
      >
        {asking()}
      </Dialog>
    </>
  );
};

render(() => <Screen />, document.getElementById("root")!);
window.__k2Mounted = true;
