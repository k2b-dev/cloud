import { createSignal } from "solid-js";
import { type Lists, TransferBoard } from "../../src/v2/behavior/dnd";

const tasks: Record<string, string> = {
  t1: "Angebot prüfen",
  t2: "Lieferung bestätigen",
  t3: "Rechnung senden",
  t4: "Fotos sortieren",
  t5: "Lack bestellen",
  t6: "Termin abgesagt",
};
const labels: Record<string, string> = { today: "Heute", later: "Später", done: "Erledigt" };

/** Tasks move between three lists; rows move live while dragging, across lists. */
export function Demo() {
  const [lists, setLists] = createSignal<Lists>({ today: ["t1", "t2", "t3"], later: ["t4", "t5"], done: ["t6"] });
  return (
    <TransferBoard
      value={lists()}
      onValueChange={setLists}
      listLabel={(list) => labels[list] ?? list}
      itemLabel={(id) => tasks[id] ?? id}
      root={{ class: "transfer" }}
      listProps={(name) => ({ class: "sortable", "data-list": name })}
      item={(id) => ({ class: "sortable__item", "data-item": id })}
      list={(name, items) => (
        <section class="transfer__col">
          <h2>{labels[name]}</h2>
          {items}
        </section>
      )}
    >
      {(id) => tasks[id]}
    </TransferBoard>
  );
}
