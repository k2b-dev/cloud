import { renderToString } from "solid-js/web";
import { Bar, Nav, type NavGroup, Pane, Text, Workspace } from "../src/v2";

// A sidebar with many places, as a Grids base with many tables: eight groups of eight entries and a foot ("Einstellungen")
// that must stay in sight. With `few`, the same sidebar with one short group, which needs no scroll.
const group = (index: number, size: number): NavGroup => ({
  label: `Gruppe ${index + 1}`,
  items: Array.from({ length: size }, (_, item) => ({
    label: `Tabelle ${index + 1}.${item + 1}`,
    icon: "table",
    href: `/app/grids/t${index + 1}-${item + 1}`,
    ...(index === 0 && item === 0 ? { current: true } : {}),
  })),
});

const Page = (props: { few?: boolean }) => (
  <Workspace
    sidebar={
      <Nav
        title="Werkstatt"
        icon="table"
        groups={props.few ? [group(0, 3)] : Array.from({ length: 8 }, (_, index) => group(index, 8))}
        foot={[{ label: "Einstellungen", icon: "settings", href: "/app/grids/settings" }]}
      />
    }
    head={<Bar start={<Text type="lead">Tabelle 1.1</Text>} />}
  >
    <Pane label="Tabelle">
      <Text>Inhalt</Text>
    </Pane>
  </Workspace>
);

/** The page as the server sends it, with many places or with few. */
export const render = (few = false) => renderToString(() => <Page few={few} />);
