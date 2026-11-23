import { createSignal } from "solid-js";
import { useCheckbox, useSwitch, useTabs, useTooltip } from "../../src/v2/behavior/controls";

/** Tabs (controlled), a tooltip, a checkbox and a switch. */
export function Demo() {
  const [tab, setTab] = createSignal("mail");
  const [unread, setUnread] = createSignal(false);
  const [notify, setNotify] = createSignal(true);
  const tabs = useTabs(() => ({ value: tab(), onValueChange: setTab }));
  const tooltip = useTooltip(() => ({ delay: 300 }));
  const check = useCheckbox(() => ({ checked: unread(), onCheckedChange: setUnread, name: "unread" }));
  const toggle = useSwitch(() => ({ checked: notify(), onCheckedChange: setNotify, name: "notify" }));
  return (
    <div class="form">
      <div>
        <tabs.List aria-label="Bereiche" class="bar">
          <tabs.Tab value="mail" class="btn">
            Mail
          </tabs.Tab>
          <tabs.Tab value="files" class="btn">
            Dateien
          </tabs.Tab>
          <tabs.Tab value="chat" class="btn" disabled>
            Chat
          </tabs.Tab>
          <tabs.Tab value="tasks" class="btn">
            Aufgaben
          </tabs.Tab>
        </tabs.List>
        <tabs.Panel value="mail">Postfach</tabs.Panel>
        <tabs.Panel value="files">Ablage</tabs.Panel>
        <tabs.Panel value="chat">Unterhaltungen</tabs.Panel>
        <tabs.Panel value="tasks">Liste</tabs.Panel>
        <output data-testid="tab">{tab()}</output>
      </div>
      <div>
        <button type="button" class="btn" data-testid="before-tooltip">
          Davor
        </button>
        <tooltip.Trigger class="btn" data-testid="tooltip-trigger" aria-label="Archivieren">
          ⌫
        </tooltip.Trigger>
        <tooltip.Popup class="popover" side="top" sideOffset={4}>
          Archivieren
        </tooltip.Popup>
      </div>
      <label class="check" id="unread-label">
        <check.Root class="btn" data-testid="checkbox" aria-labelledby="unread-label">
          <check.Mark>✓</check.Mark>
        </check.Root>
        Nur ungelesene
      </label>
      <output data-testid="checked">{String(unread())}</output>
      <div class="check">
        <toggle.Root class="btn" data-testid="switch" aria-label="Benachrichtigen">
          <toggle.Mark>●</toggle.Mark>
        </toggle.Root>
        <output data-testid="switched">{String(notify())}</output>
      </div>
    </div>
  );
}
