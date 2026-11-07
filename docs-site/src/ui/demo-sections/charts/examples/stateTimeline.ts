import { inspectA11y } from "./common";
import type { ChartShowcaseExample } from "./types";

const examples: ChartShowcaseExample[] = [
  {
    id: "state-timeline-workers",
    kind: "stateTimeline",
    question: "flow",
    title: "State timeline",
    summary: "What state each item was in and for how long. Errors and pauses stand out as colored stretches.",
    spec: {
      kind: "stateTimeline",
      rows: [
        {
          label: "Import",
          intervals: [
            { from: 0, to: 3, state: "ok", tooltip: "Idle" },
            { from: 3, to: 7, state: "running", tooltip: "Importing orders" },
            { from: 7, to: 12, state: "ok", tooltip: "Idle" },
          ],
        },
        {
          label: "Mail sync",
          intervals: [
            { from: 0, to: 5, state: "running", tooltip: "Syncing" },
            { from: 5, to: 6, state: "error", tooltip: "Server did not answer" },
            { from: 6, to: 12, state: "running", tooltip: "Syncing" },
          ],
        },
        {
          label: "Backup",
          intervals: [
            { from: 0, to: 9, state: "ok", tooltip: "Waiting" },
            { from: 9, to: 11, state: "running", tooltip: "Nightly backup" },
            { from: 11, to: 12, state: "ok", tooltip: "Done" },
          ],
        },
      ],
      states: [
        { state: "ok", label: "Idle", color: "var(--stdlib-chart-c2)" },
        { state: "running", label: "Running", color: "var(--stdlib-chart-c1)" },
        { state: "error", label: "Error", color: "var(--k2b-danger-500)" },
      ],
      domain: [0, 12],
      interactive: true,
    },
    useFor: ["Status history of jobs, services or machines.", "Where errors happened and how long they lasted."],
    avoidFor: ["Amounts; use a line or bar chart.", "Dozens of rows; filter to the ones that need attention."],
    a11y: [
      ...inspectA11y.slice(0, 1),
      "Arrow keys pan the time range; Alt with arrow keys inspects the stretches; a link on a stretch stays a link.",
      ...inspectA11y.slice(1),
    ],
    options: [
      {
        name: "rows",
        type: "{ label, intervals: { from, to, state, tooltip?, href? }[] }[]",
        description: "One row per item with its stretches.",
      },
      { name: "states", type: "{ state, label, color }[]", description: "Names and colors of the states, shown in the legend." },
      { name: "domain", type: "[from, to]", description: "The visible time range." },
      { name: "interactive", type: "boolean", description: "Adds pan, zoom and reset controls." },
    ],
  },
];

export default examples;
