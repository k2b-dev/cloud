export const bubbleExamples = [
  {
    id: "bubble-campaigns",
    kind: "bubble",
    question: "distribution" as const,
    title: "Campaign reach and engagement",
    summary: "Compare visits, opens and audience for fictional campaigns; guides show the unweighted averages.",
    spec: {
      kind: "bubble",
      title: "Campaigns",
      groups: ["North", "South"],
      xLabel: "Visits",
      yLabel: "Opens",
      sizeLabel: "Audience",
      averages: true,
      data: [
        { label: "Letter A", group: "North", x: 120, y: 80, size: 400 },
        { label: "Letter B", group: "North", x: 240, y: 120, size: 900 },
        { label: "Letter C", group: "South", x: 180, y: 160, size: 600 },
      ],
    },
    height: 280,
    width: "half" as const,
    useFor: ["Comparing two measures and one nonnegative area measure for named observations.", "Named scatter points: omit size."],
    avoidFor: ["Precise ranking of many similarly sized bubbles."],
    a11y: ["Names that cannot fit stay in the tooltip and table.", "Arrows inspect; Enter selects; Escape dismisses."],
    options: [
      { name: "averages", type: "boolean", description: "Show explicitly labelled unweighted averages." },
      { name: "data[].size", type: "number >= 0", description: "Optional per-point field. Bubble area is proportional to size." },
    ],
  },
];
