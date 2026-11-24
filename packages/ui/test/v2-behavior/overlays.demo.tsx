import { createSignal, For } from "solid-js";
import { useDialog, useMenu, usePopover } from "../../src/v2/behavior/overlays";

const actionLabels: Record<string, string> = { read: "Als gelesen markiert", archive: "Archiviert", delete: "Gelöscht" };
const menuItems = [
  { value: "read", label: "Als gelesen markieren" },
  { value: "archive", label: "Archivieren" },
  { value: "delete", label: "Löschen" },
];

/** Dialog (controlled), action menu and popover, as the spike's Actions island. */
export function Demo() {
  const [open, setOpen] = createSignal(false);
  const [status, setStatus] = createSignal("Bereit");
  const dialog = useDialog(() => ({ open: open(), onOpenChange: setOpen }));
  const menu = useMenu(() => ({ onAction: (value: string) => setStatus(actionLabels[value] ?? value) }));
  const popover = usePopover();
  return (
    <div class="bar">
      <span class="status" data-testid="actions-status" aria-live="polite">
        {status()}
      </span>
      <popover.Trigger class="btn" data-testid="filter-trigger">
        Filter
      </popover.Trigger>
      <popover.Popup class="popover" side="bottom" align="start" sideOffset={6} collisionPadding={8}>
        <popover.Title class="popover__title">Filter</popover.Title>
        <label class="check">
          <input type="checkbox" name="unread" /> Nur ungelesene
        </label>
        <label class="check">
          <input type="checkbox" name="attachments" /> Mit Anhang
        </label>
      </popover.Popup>
      <menu.Trigger class="btn" data-testid="menu-trigger">
        Mehr
      </menu.Trigger>
      <menu.Popup class="menu" align="end" sideOffset={4} collisionPadding={8}>
        <For each={menuItems.slice(0, 2)}>
          {(item) => (
            <menu.Item class="menu__item" value={item.value} label={item.label}>
              {item.label}
            </menu.Item>
          )}
        </For>
        <menu.Separator class="menu__sep" />
        <menu.Item class="menu__item" value="delete" label="Löschen">
          Löschen
        </menu.Item>
      </menu.Popup>
      <dialog.Trigger class="btn btn--primary" data-testid="dialog-trigger">
        Neue Nachricht
      </dialog.Trigger>
      <dialog.Popup class="dialog" backdrop={{ class: "veil" }}>
        <dialog.Title class="dialog__title">Neue Nachricht</dialog.Title>
        <div class="dialog__body">
          <label class="field">
            <span>An</span>
            <input class="input" name="to" autocomplete="off" />
          </label>
          <label class="field">
            <span>Betreff</span>
            <input class="input" name="subject" autocomplete="off" />
          </label>
        </div>
        <div class="dialog__foot">
          <button type="button" class="btn" onClick={() => setOpen(false)}>
            Abbrechen
          </button>
          <button
            type="button"
            class="btn btn--primary"
            onClick={() => {
              setStatus("Gesendet");
              setOpen(false);
            }}
          >
            Senden
          </button>
          <dialog.Close class="btn" aria-label="Schließen">
            ✕
          </dialog.Close>
        </div>
      </dialog.Popup>
    </div>
  );
}
