import { createSignal, For, Show } from "solid-js";
import { Column, Head, Icon, type IconName, Scroll, Sidebar, SideLabel } from "@k2b/ui/v2";
import { createDragOnto, SortableList } from "@k2b/ui/v2/dnd";

export type BoardMail = { id: string; from: string; subject: string; time: string; unread?: boolean };
export type BoardFolder = { id: string; label: string; icon: IconName };

/**
 * Drag and drop on ui-sdk: the folder favourites sort (createReorder), and a mail drags onto a folder
 * (bindDrag + bindDragPreview + createAutoScroll + announce). Mouse, touch (hold) and keyboard.
 */
export default function MailBoard(props: { inbox: string; mails: BoardMail[]; folders: BoardFolder[] }) {
  const [order, setOrder] = createSignal(props.folders.map((folder) => folder.id));
  const [place, setPlace] = createSignal<Record<string, string>>(Object.fromEntries(props.mails.map((mail) => [mail.id, "inbox"])));
  const [last, setLast] = createSignal("");
  const folder = (id: string) => props.folders.find((entry) => entry.id === id);
  const subject = (id: string) => props.mails.find((mail) => mail.id === id)?.subject ?? id;
  const shown = () => props.mails.filter((mail) => place()[mail.id] === "inbox");
  const count = (id: string) => props.mails.filter((mail) => place()[mail.id] === id).length;
  const drag = createDragOnto({
    targets: () => order().map((id) => ({ id, label: folder(id)?.label ?? id })),
    itemLabel: subject,
    accepts: (key, target) => place()[key] !== target,
    onDrop: (key, target) => {
      // A keyboard drop removes the focused row; focus goes to the grip that takes its place.
      const at = shown().findIndex((mail) => mail.id === key);
      const keyboard = document.activeElement?.closest("[data-mail]") !== null;
      setPlace((current) => ({ ...current, [key]: target }));
      if (keyboard) {
        requestAnimationFrame(() => {
          const grips = document.querySelectorAll<HTMLElement>("[data-mail] .k2-grip");
          grips[Math.min(at, grips.length - 1)]?.focus();
        });
      }
      setLast(`„${subject(key)}“ liegt jetzt in ${folder(target)?.label}.`);
    },
  });
  const status = () => {
    const key = drag.moving();
    if (!key) return last() || `${shown().length} Nachrichten`;
    const target = drag.over();
    return target ? `„${subject(key)}“ nach ${folder(target)?.label}` : `„${subject(key)}“ ziehen – über einem Ordner loslassen`;
  };

  return (
    <>
      <Sidebar title="Mail" icon="mail">
        <SideLabel>Postfach</SideLabel>
        <a class="k2-nav" href="/dnd" aria-current="page">
          <Icon name="inbox" />
          <span class="k2-fill k2-cut">{props.inbox}</span>
          <span class="k2-nav__count">{shown().length}</span>
        </a>
        <SideLabel>Ordner</SideLabel>
        <SortableList label="Ordner, sortierbar" value={order()} onValueChange={setOrder} itemLabel={(id) => folder(id)?.label ?? id}>
          {(id) => (
            <div class="k2-nav" data-drop-target={id} data-over={drag.over() === id ? "" : undefined}>
              <Icon name={folder(id)?.icon ?? "folder"} />
              <span class="k2-fill k2-cut">{folder(id)?.label}</span>
              <Show when={count(id)}>
                <span class="k2-nav__count">{count(id)}</span>
              </Show>
            </div>
          )}
        </SortableList>
      </Sidebar>
      <Column region="main" label={props.inbox}>
        <Head title={props.inbox} status={<span data-testid="board-status">{status()}</span>} />
        <Scroll label="Nachrichten">
          <p id="board-help" class="k2-sr">
            Leertaste nimmt die Nachricht auf. Pfeiltasten wählen den Ordner, Enter legt ab, Escape bricht ab.
          </p>
          <ul class="k2-list" aria-label="Nachrichten">
            <For each={shown()}>
              {(mail) => (
                <li
                  class="k2-row k2-drag-row"
                  data-mail={mail.id}
                  data-moving={drag.moving() === mail.id ? "" : undefined}
                  onPointerDown={(event) => drag.pointerdown(event, event.currentTarget, mail.id)}
                >
                  <button
                    type="button"
                    class="k2-grip"
                    aria-label={`Verschieben: ${mail.subject}`}
                    aria-describedby="board-help"
                    onKeyDown={(event) => drag.keydown(event, mail.id)}
                  >
                    <Icon name="grip" />
                  </button>
                  <div class="k2-row__main">
                    <div class="k2-row__line">
                      <span class="k2-fill k2-cut">
                        <Show when={mail.unread} fallback={mail.from}>
                          <b class="k2-strong">{mail.from}</b>
                        </Show>
                      </span>
                      <span class="k2-meta k2-num">{mail.time}</span>
                    </div>
                    <div class="k2-row__line">
                      <span class="k2-fill k2-cut">{mail.subject}</span>
                    </div>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Scroll>
      </Column>
    </>
  );
}
