import { render } from "solid-js/web";
import { Bar, Icon, Pane, RangeBar, Table, Text, Workspace } from "../src/v2";

// A week of weather, as a weather app shows it: each day from its low to its high on the week's one scale, coloured
// cold to warm in both themes. One day holds a single value, one runs past the scale's end. Under the table stand a
// coloured bar that also shows on the phone, a bar at the scale's very end, the same week in a right-to-left line, a
// neutral bar and a coloured sign. The test reads place, size, colours, contrast, direction and the forced-colors look.

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
// cold to warm, each colour at 3:1 on the surface in light and in dark
const stops = [
  { at: -4, color: "light-dark(#1d4ed8, #93c5fd)" },
  { at: 4, color: "light-dark(#0f766e, #2dd4bf)" },
  { at: 10, color: "light-dark(#15803d, #4ade80)" },
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
        <div id="loose" style={{ padding: "8px 20px", display: "grid", gap: "8px" }}>
          <RangeBar from={-2} to={8} domain={domain} stops={stops} label="-2° bis 8°" />
          <RangeBar from={10} to={10} domain={domain} label="10° bis 10°" />
          <div dir="rtl">
            <RangeBar from={-2} to={8} domain={domain} stops={stops} label="rtl" />
          </div>
          <RangeBar from={1} to={3} domain={[0, 4]} label="neutral" />
          <Icon name="sun" label="Sonne" color="light-dark(#b45309, #fbbf24)" />
        </div>
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
