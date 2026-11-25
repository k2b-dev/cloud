import { createSignal } from "solid-js";
import { Bar, Pane, Tabs, Text, Workspace } from "../src/v2";

// Both kinds of tabs: views in the head that change the address (a navigation), and "Vorschau | Code" of an example
// that switch a panel in place (the WAI-ARIA tabs pattern), with the same look.

export function Demo() {
  const [shown, setShown] = createSignal<"preview" | "code" | "props">("preview");
  const tab = (key: "preview" | "code" | "props", label: string) => ({ label, current: shown() === key, onClick: () => setShown(key) });
  return (
    <Workspace
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={[
                { label: "Alle", count: 12, href: "?view=all", current: true },
                { label: "Online", count: 2, href: "?view=online" },
              ]}
            />
          }
        />
      }
    >
      <Pane
        label="Beispiel"
        head={
          <Tabs label="Beispiel" panel="example" items={[tab("preview", "Vorschau"), tab("code", "Code"), tab("props", "Eigenschaften")]} />
        }
      >
        <Tabs.Panel id="example">
          <Text>{shown() === "preview" ? "Die Vorschau" : shown() === "code" ? "Der Code" : "Die Eigenschaften"}</Text>
        </Tabs.Panel>
      </Pane>
    </Workspace>
  );
}
