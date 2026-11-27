import { Bar, Menu, Pane, Text, Workspace } from "../src/v2";

// A filter menu of areas in the bar of a pane, as the Notebooks graph has it (W2; a menu with words in the head gives
// way on the phone, so it stands in the pane here): each area with its data colour as a dot before its
// words, one area without a colour, and one whose colour is no colour at all (it must not reach the page). The names
// are invented.

export function Demo() {
  return (
    <Workspace head={<Bar start={<Text type="lead">Graph</Text>} />}>
      <Pane label="Graph">
        <Bar
          start={<Text type="lead">Graph</Text>}
          end={
            <Menu
              items={[
                {
                  title: "Bereich",
                  choice: "werkstatt",
                  items: [
                    { label: "Werkstatt", value: "werkstatt", color: "#0f766e" },
                    { label: "Büro", value: "buero", color: "#7c3aed" },
                    { label: "Lager", value: "lager" },
                    { label: "Fremd", value: "fremd", color: "red;background:url(https://example.invalid/x.png)" },
                  ],
                },
              ]}
            >
              Bereich
            </Menu>
          }
        />
        <Text>Der Graph der Notizen.</Text>
      </Pane>
    </Workspace>
  );
}
