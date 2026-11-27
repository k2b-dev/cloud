import { render } from "solid-js/web";
import { Bar, Pane, RangeBar, Table, Text, Workspace } from "../src/v2";

// A week of weather, as a weather app shows it: each day from its low to its high on the week's one scale, coloured
// cold to warm. One day holds a single value, one runs past the scale's end. The test reads place, size, colours and
// the forced-colors look.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

const days = [
  { day: "Heute", low: 2.9, high: 9.1 },
  { day: "Sa.", low: -3.4, high: 4.6 },
  { day: "So.", low: 5, high: 5 },
  { day: "Mo.", low: -1.2, high: 14 },
];
const domain = [-4, 10] as const;
const stops = [
  { at: -4, color: "#1d4ed8" },
  { at: 4, color: "#0f766e" },
  { at: 10, color: "#15803d" },
];
const words = (day: (typeof days)[number]) => `${day.low}° bis ${day.high}°`;

const root = document.getElementById("root");
if (!root) throw new Error("range bar: #root is missing");
render(
  () => (
    <Workspace head={<Bar start={<Text type="lead">Woche</Text>} />}>
      <Pane label="Woche">
        <Table
          label="Woche"
          rows={days}
          rowKey={(row) => row.day}
          phone={(row) => ({ lines: [row.day, words(row)] })}
          columns={[
            { title: "Tag", width: { min: 64, default: 80 }, cell: (row) => row.day },
            {
              title: "Temperatur",
              cell: (row) => <RangeBar from={row.low} to={row.high} domain={domain} stops={stops} label={words(row)} />,
            },
          ]}
        />
        <RangeBar from={1} to={3} domain={[0, 4]} label="neutral" />
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
