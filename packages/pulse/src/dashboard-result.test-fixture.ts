import { DashboardPanelSchema } from "./dashboard-contracts";
import { projectDashboardPanel } from "./dashboard-result";

const panel = DashboardPanelSchema.parse({
  id: "large-values",
  title: "Large values",
  kind: "line",
  sql: "SELECT at, value",
  columns: ["at", "value"],
  x: "at",
});
const projected = [1e17, 1e17 + 16].map(
  (second) =>
    projectDashboardPanel(panel, {
      columns: [
        { name: "at", type: "DateTime64(3, 'UTC')" },
        { name: "value", type: "Float64" },
      ],
      rows: [
        ["2026-10-22 12:00:00.000", 1e17],
        ["2026-10-22 13:00:00.000", second],
      ],
      truncated: false,
      rowCount: 2,
      stats: { elapsedMs: 1, readRows: 2, readBytes: 1 },
    }).rows,
);
console.log(JSON.stringify(projected));
