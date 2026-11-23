import { createSignal, For, Show } from "solid-js";
import { createDragOnto, SortableList } from "../../src/v2/behavior/dnd";

const folders = [
  { id: "suppliers", label: "Lieferanten" },
  { id: "invoices", label: "Rechnungen" },
  { id: "oak", label: "Projekt Eichentisch" },
  { id: "drafts", label: "Entwürfe" },
  { id: "archive", label: "Archiv" },
];
const mails = [
  { id: "m1", from: "Holzhandel Berger", subject: "Angebot Eichenplatten" },
  { id: "m2", from: "Steuerbüro Lange", subject: "Unterlagen für das dritte Quartal" },
  { id: "m3", from: "Werkstatt Huber", subject: "Termin für die Abholung" },
  { id: "m4", from: "Spedition Kern", subject: "Lieferung verschoben auf Freitag" },
  { id: "m5", from: "Anna Roth", subject: "Fotos vom Tisch" },
  { id: "m6", from: "Lackierei Stein", subject: "Rechnung 2026-114" },
];

/** The spike's board: folders sort (rows move live), a mail drags onto a folder. Mouse, touch and keyboard. */
export function Demo() {
  const [order, setOrder] = createSignal(folders.map((folder) => folder.id));
  const [place, setPlace] = createSignal<Record<string, string>>(Object.fromEntries(mails.map((mail) => [mail.id, "inbox"])));
  const [last, setLast] = createSignal("");
  const folder = (id: string) => folders.find((entry) => entry.id === id)?.label ?? id;
  const subject = (id: string) => mails.find((mail) => mail.id === id)?.subject ?? id;
  const shown = () => mails.filter((mail) => place()[mail.id] === "inbox");
  const count = (id: string) => mails.filter((mail) => place()[mail.id] === id).length;
  const drag = createDragOnto({
    targets: () => order().map((id) => ({ id, label: folder(id) })),
    itemLabel: subject,
    accepts: (key, target) => place()[key] !== target,
    onDrop: (key, target) => {
      // A keyboard drop removes the focused row; focus goes to the grip that takes its place. Solid 1 has updated the
      // list when the setter returns, so focus moves now, not a frame later.
      const at = shown().findIndex((mail) => mail.id === key);
      const keyboard = document.activeElement?.closest("[data-mail]") !== null;
      setPlace((current) => ({ ...current, [key]: target }));
      if (keyboard) {
        const grips = document.querySelectorAll<HTMLElement>("[data-mail] .handle");
        grips[Math.min(at, grips.length - 1)]?.focus();
      }
      setLast(`„${subject(key)}“ liegt jetzt in ${folder(target)}.`);
    },
  });
  const status = () => {
    const key = drag.moving();
    if (!key) return last() || `${shown().length} Nachrichten`;
    const target = drag.over();
    return target ? `„${subject(key)}“ nach ${folder(target)}` : `„${subject(key)}“ ziehen`;
  };
  return (
    <div class="page">
      <nav aria-label="Ordner">
        <SortableList
          label="Ordner"
          value={order()}
          onValueChange={setOrder}
          itemLabel={folder}
          root={{ class: "sortable" }}
          item={() => ({ class: "sortable__item" })}
        >
          {(id) => (
            <div class="target" data-drop-target={id} data-over={drag.over() === id ? "" : undefined}>
              {folder(id)}
              <Show when={count(id)}> {count(id)}</Show>
            </div>
          )}
        </SortableList>
      </nav>
      <main>
        <p data-testid="board-status">{status()}</p>
        <ul class="sortable" aria-label="Nachrichten">
          <For each={shown()}>
            {(mail) => (
              <li class="mail" data-mail={mail.id} {...drag.item(mail.id)}>
                <button type="button" class="handle" data-k2-drag-handle aria-label={`Verschieben: ${mail.subject}`}>
                  ⠿
                </button>
                {/* One text node: the server joins interpolated text into one node, the client keeps three, and the
                    shaping across node boundaries differs by subpixels (the reload contract caught it). */}
                {`${mail.from} – ${mail.subject}`}
              </li>
            )}
          </For>
        </ul>
      </main>
    </div>
  );
}
