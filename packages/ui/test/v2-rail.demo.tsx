import { Pane, Rail, Row, TabBar, Workspace } from "../src/v2";

// An app's frame from 768 px with the worst case of places: Start and 19 parts beside the page (invented places), a
// count on one, and Settings at the foot; below 768 px the tab bar of the same places. Spaces is the open place.

const places = [
  { label: "Start", icon: "home", href: "#start" },
  { label: "Chat", icon: "messages", href: "#chat", unread: 3 },
  { label: "Spaces", icon: "layout-kanban", href: "#spaces", current: true },
  ...Array.from({ length: 17 }, (_, index) => ({
    label: `Standortübergreifende Lagerliste Nord ${index + 1}`,
    icon: "building",
    href: `#lager-${index + 1}`,
  })),
];

const LOGO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Crect width='20' height='20' rx='5' fill='%239a3412'/%3E%3C/svg%3E";

export function Demo() {
  return (
    <div class="demo-frame">
      <div class="demo-rail">
        <Rail
          label="Lindenhof Cloud"
          logo={LOGO}
          items={places}
          foot={[{ label: "Einstellungen", icon: "settings", href: "#einstellungen" }]}
        />
      </div>
      <Workspace>
        <Pane label="Spaces">
          <Row icon="layout-kanban" lines={["Programm Dezember", "12 offene Aufgaben"]} href="#board" />
        </Pane>
      </Workspace>
      <TabBar label="App" items={places} />
    </div>
  );
}
