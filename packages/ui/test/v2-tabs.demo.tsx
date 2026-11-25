import { createSignal } from "solid-js";
import { isServer } from "solid-js/web";

declare global {
  interface Window {
    /** Before the bundle: the example gets three more tabs and opens on the last one, so tabs hide at a narrow width. */
    __manyTabs?: boolean;
  }
}
import { Bar, Pane, Tabs, Text, Workspace } from "../src/v2";

// Both kinds of tabs: views in the head that change the address (a navigation), and "Vorschau | Code" of an example
// that switch a panel in place (the WAI-ARIA tabs pattern), with the same look.

export function Demo() {
  const many = !isServer && window.__manyTabs === true;
  const [shown, setShown] = createSignal(many ? "history" : "preview");
  const tab = (key: string, label: string) => ({ label, current: shown() === key, onClick: () => setShown(key) });
  const more = many ? [tab("a11y", "Barrierefreiheit"), tab("variants", "Varianten"), tab("history", "Verlauf der Änderungen")] : [];
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
          <Tabs label="Beispiel" panel="example" items={[tab("preview", "Vorschau"), tab("code", "Code"), tab("props", "Eigenschaften"), ...more]} />
        }
      >
        <Tabs.Panel id="example">
          <Text>
            {shown() === "preview" ? "Die Vorschau" : shown() === "code" ? "Der Code" : shown() === "props" ? "Die Eigenschaften" : shown()}
          </Text>
        </Tabs.Panel>
      </Pane>
    </Workspace>
  );
}
