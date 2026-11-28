import { render } from "solid-js/web";
import { Bar, Pane, RangeBar, Table, Text, Workspace } from "../src/v2";

// A week of opening hours on one scale from 6 to 24: some days with a break (two ranges in one row), one closed day
// (no range), today as the table's open row. The times stand as text in their own column, so each bar is decoration
// beside them. The test reads the bars' places, the open row's tint and the layout at 1440 and 390 px, where
// the three columns still stand side by side.

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

type Day = { day: string; name: string; hours: { from: number; to: number }[] };
const week: Day[] = [
  { day: "mo", name: "Mo.", hours: [{ from: 8, to: 15 }] },
  {
    day: "di",
    name: "Di.",
    hours: [
      { from: 8, to: 12 },
      { from: 14, to: 18 },
    ],
  },
  { day: "mi", name: "Mi.", hours: [{ from: 8, to: 15 }] },
  {
    day: "do",
    name: "Do.",
    hours: [
      { from: 11.5, to: 14 },
      { from: 17, to: 22 },
    ],
  },
  { day: "fr", name: "Fr.", hours: [{ from: 8, to: 23 }] },
  { day: "sa", name: "Sa.", hours: [{ from: 10, to: 15 }] },
  { day: "so", name: "So.", hours: [] },
];
const time = (hour: number) => `${String(Math.floor(hour)).padStart(2, "0")}:${String(Math.round((hour % 1) * 60)).padStart(2, "0")}`;
const times = (day: Day) =>
  day.hours.length === 0 ? "Geschlossen" : day.hours.map((range) => `${time(range.from)}–${time(range.to)}`).join(", ");

const root = document.getElementById("root");
if (!root) throw new Error("range bar ranges: #root is missing");
render(
  () => (
    <Workspace head={<Bar start={<Text type="lead">Öffnungszeiten</Text>} />}>
      <Pane label="Öffnungszeiten">
        <Table
          label="Öffnungszeiten"
          rows={week}
          rowKey={(row) => row.day}
          current="sa"
          columns={[
            { title: "Tag", width: { min: 56, default: 64 }, cell: (row) => row.name },
            { title: "Verlauf", cell: (row) => <RangeBar ranges={row.hours} domain={[6, 24]} decorative /> },
            { title: "Zeiten", width: { min: 120, default: 140 }, align: "end", cell: (row) => times(row) },
          ]}
        />
      </Pane>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
