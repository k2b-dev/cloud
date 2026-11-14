/** Fictional data; ChartShowcaseExample[] shape for the shared registry. */
export const paretoExamples = [
  {
    id: "pareto-regions",
    kind: "pareto",
    question: "compare" as const,
    title: "Revenue by region",
    summary: "Ranked current and previous values with cumulative share and an 80% reference.",
    spec: {
      kind: "pareto",
      title: "Revenue by region",
      labels: ["2026", "2025"],
      data: [
        {
          label: "North",
          value: 140000,
          prev: 120000,
        },
        {
          label: "East",
          value: 105000,
          prev: 97000,
        },
        {
          label: "South",
          value: 86000,
          prev: 90000,
        },
        {
          label: "West",
          value: 67000,
          prev: 60000,
        },
        {
          label: "Rest",
          rest: true,
          value: 32000,
          prev: 29000,
        },
      ],
    },
    height: 280,
    width: "half" as const,
    useFor: ["Finding the few categories that account for most of a total."],
    avoidFor: ["Signed values or a time trend."],
    a11y: [
      "Arrow keys move between ranked categories; Home/End jump, Enter selects and Escape dismisses.",
      "Tooltip and table name both periods, the change and cumulative share.",
    ],
    options: [
      {
        name: "labels",
        type: "[string,string]",
        description: "Current and previous period names.",
      },
      {
        name: "data",
        type: "{label,value,prev,rest?}[]",
        description: "Nonnegative values; sorted descending, with rest: true categories last.",
      },
    ],
  },
];
