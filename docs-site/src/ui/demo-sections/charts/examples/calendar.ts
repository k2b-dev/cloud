export const calendarExamples = [
  {
    id: "calendar-newsletter",
    kind: "heatmap",
    question: "trend" as const,
    title: "Opens per day",
    summary: "Find active days and weekly patterns across a fictional newsletter year.",
    spec: {
      kind: "heatmap",
      layout: "calendar",
      title: "Opens per day",
      scale: "sequential",
      data: Array.from({ length: 365 }, (_, i) => [
        new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10),
        (i * 17) % 211,
      ]),
    },
    height: 220,
    width: "full" as const,
    useFor: ["Daily observations and weekly patterns."],
    avoidFor: ["Exact comparisons between close values."],
    a11y: [
      "Left/right inspect a week; up/down inspect a day. Home/End jump; Enter pins; Escape dismisses.",
      "All dates remain in the table. Newest weeks are visible first on phones.",
    ],
    options: [
      { name: "layout", type: '"calendar"', description: "Additive to the existing heatmap kind." },
      {
        name: "data",
        type: "[ISO day,number | null][]",
        description: "Unique valid YYYY-MM-DD days across at most three years; missing and null days are gaps.",
      },
      { name: "scale", type: '"sequential" | "diverging"', description: "Colors use every observation, including scrolled-out weeks." },
    ],
  },
];
