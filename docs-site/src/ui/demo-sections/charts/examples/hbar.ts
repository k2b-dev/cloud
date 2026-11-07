export const hbarExamples = [
  {
    id: "hbar-groups",
    kind: "hbar",
    question: "compare",
    title: "Orders by category and channel",
    summary: "Groups retain long category names; each row ends with its total.",
    spec: {
      kind: "hbar",
      title: "Orders by category and channel",
      series: ["Q1", "Q2", "Q3", "Q4"],
      rows: [
        { group: "Store", label: "Furniture", values: [35, 36, 50, 43] },
        { group: "Store", label: "Lighting", values: [49, 46, 47, 34] },
        { group: "Web", label: "Furniture", values: [50, 43, 39, 46] },
        { group: "Web", label: "Pictures", values: [41, 37, 40, 43] },
      ],
    },
    height: 300,
    width: "half",
    useFor: ["Grouped categories with long names"],
    avoidFor: ["Negative segments"],
    a11y: [
      "Arrow keys inspect a whole row with every segment and total.",
      "Values too narrow to print remain in inspection and the table.",
    ],
    options: [
      {
        name: "rows",
        type: "{ group?, label, values }[]",
        description: "Nonnegative aligned segment values, with optional group headings.",
      },
    ],
  },
];
