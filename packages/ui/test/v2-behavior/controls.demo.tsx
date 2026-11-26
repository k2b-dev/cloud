import { createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import { useTabs } from "../../src/v2/behavior/controls";

/** Counts its mounts and cleanups: content of an inactive panel must neither exist nor outlive its panel. */
function MountCounter() {
  if (!isServer) {
    onMount(() => {
      window.__panelMounts = (window.__panelMounts ?? 0) + 1;
    });
    onCleanup(() => {
      window.__panelCleanups = (window.__panelCleanups ?? 0) + 1;
    });
  }
  return null;
}

/** Tabs (controlled). */
export function Demo() {
  const [tab, setTab] = createSignal("mail");
  const tabs = useTabs(() => ({ value: tab(), onValueChange: setTab }));
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
        <tabs.Panel value="files">
          Ablage
          <MountCounter />
        </tabs.Panel>
        <tabs.Panel value="chat">Unterhaltungen</tabs.Panel>
        <tabs.Panel value="tasks">Liste</tabs.Panel>
        <output data-testid="tab">{tab()}</output>
      </div>
    </div>
  );
}
