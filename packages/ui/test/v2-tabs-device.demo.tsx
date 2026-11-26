import { createSignal } from "solid-js";
import { Pane, Tabs, Text, Workspace } from "../src/v2";

// A graph with three displays (Notebooks #4245): while the address names none, the phone opens the list and the
// desktop the graph. The server does not know the width, so both tabs carry their device; the stylesheet marks the
// right one from the first paint. A second row of tabs with a plain open tab is the look of an open tab to compare
// with. `window.__pick` opens a display as a person's choice, which wins on every device.

declare global {
  interface Window {
    __pick?: (display: string) => void;
  }
}

export function Demo() {
  const [picked, setPicked] = createSignal<string>();
  if (typeof window !== "undefined") window.__pick = setPicked;
  const open = (display: string, device: "phone" | "desktop" | undefined) => {
    const chosen = picked();
    return chosen === undefined ? device : chosen === display;
  };
  return (
    <Workspace>
      <Pane
        label="Graph"
        head={
          <Tabs
            label="Darstellung"
            items={[
              { label: "Graph", icon: "chart-dots-3", current: open("graph", "desktop"), onClick: () => setPicked("graph") },
              { label: "Liste", icon: "list", current: open("list", "phone"), onClick: () => setPicked("list") },
              { label: "Tabelle", icon: "table", current: open("table", undefined), onClick: () => setPicked("table") },
            ]}
          />
        }
      >
        <Tabs
          label="Vergleich"
          items={[
            { label: "Offen", current: true, onClick: () => undefined },
            { label: "Zu", onClick: () => undefined },
          ]}
        />
        <Text>{picked() ?? "Standard"}</Text>
      </Pane>
    </Workspace>
  );
}
