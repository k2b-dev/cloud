import { useMenuLevels } from "../src/v2/behavior/menu";

// A group whose props are missing at the moment of choice (#4361), made on purpose: two radio entries stand without
// their RadioGroup, so core holds no props for the group when one is chosen. Core then calls no group handler and
// keeps the value in its own memory; the menu's `onChoice` is the one way the choice still arrives. Each choice that
// arrives lands in `window.__lostChoices`.

declare global {
  interface Window {
    __lostChoices?: string[];
  }
}

export function Demo() {
  const level = useMenuLevels();
  // optional: before #4361 a menu had no such receiver, and nothing heard the choice
  level.onChoice?.("lost", (value) => {
    window.__lostChoices = [...(window.__lostChoices ?? []), value];
  });
  return (
    <>
      <level.Trigger class="k2-btn" data-k2-part="Button">
        Ansicht
      </level.Trigger>
      <level.Popup class="k2-menu" data-k2-part="Menu" side="bottom" sideOffset={4}>
        <level.RadioItem group="lost" value="all" label="Alle Chats" closeOnSelect class="k2-mi">
          Alle Chats
        </level.RadioItem>
        <level.RadioItem group="lost" value="archived" label="Archiviert" closeOnSelect class="k2-mi">
          Archiviert
        </level.RadioItem>
      </level.Popup>
    </>
  );
}
