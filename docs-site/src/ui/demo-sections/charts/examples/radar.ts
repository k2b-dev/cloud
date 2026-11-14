export const radarExamples = [
  {
    id: "radar-plans",
    kind: "radar",
    question: "compare" as const,
    title: "Compare two plans",
    summary: "Two fictional plans share the same five-point scale on every axis.",
    spec: {
      kind: "radar",
      title: "Plan scores",
      axes: ["Quality", "Speed", "Cost", "Access"],
      max: 5,
      unit: "points",
      series: [
        { label: "Plan A", data: [4, 3, 2, 5] },
        { label: "Plan B", data: [2, 4, 4, 3] },
      ],
    },
    height: 280,
    width: "half" as const,
    useFor: ["Comparing profiles on 3–8 axes with the same unit and maximum."],
    avoidFor: ["Combining unrelated units or independently scaled axes."],
    a11y: ["Each axis tooltip includes every series.", "Arrow keys move across axes; Home and End reach the first and last."],
    options: [
      { name: "max", type: "number > 0", description: "One common maximum for every axis." },
      { name: "series", type: "1..4 series", description: "Exactly one bounded value per axis." },
    ],
  },
];
