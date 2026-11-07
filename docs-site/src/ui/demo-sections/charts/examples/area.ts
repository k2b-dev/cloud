const common = {
  kind: "area",
  layout: "stacked",
  x: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
  series: [
    { label: "Subscriptions", data: [120, 140, 130, 150, 170, 180] },
    { label: "Projects", data: [180, 160, 170, 140, 130, 120] },
    { label: "Training", data: [40, 50, 60, 50, 60, 80] },
  ],
};
export const areaExamples = [
  {
    id: "area-stacked",
    kind: "area",
    question: "trend" as const,
    title: "Sales from three sources",
    summary: "Absolute areas show how each source contributes to the invented studio's total sales.",
    spec: { ...common, title: "Studio sales" },
    height: 280,
    width: "twoThirds" as const,
    useFor: ["A changing total made up of nonnegative parts."],
    avoidFor: ["Negative changes or many crossing series; use lines instead."],
    a11y: [
      "Arrow keys, Home and End inspect every available X position.",
      "The tooltip names every series at the cursor. Enter pins it; Escape closes it.",
      "Null observations and zero totals are gaps, never zero-valued shares.",
    ],
    options: [
      { name: "layout", type: '"stacked"', description: "Accumulate nonnegative source values at each X position." },
      {
        name: "x",
        type: "(string | number)[]",
        description: "Ordered coordinates shared by all series. Every series has the same length.",
      },
      { name: "series", type: "{label:string,data:(number|null)[]}[]", description: "Amounts, with null for missing observations." },
    ],
  },
  {
    id: "area-normalized",
    kind: "area",
    question: "share" as const,
    title: "How the sales mix changes",
    summary: "The same invented sales as a 100 % area. Tooltips and the table retain both source amount and share.",
    spec: { ...common, title: "Studio sales mix", normalize: true },
    height: 280,
    width: "twoThirds" as const,
    useFor: ["Compare the composition of a changing whole over time."],
    avoidFor: ["Compare absolute totals, which normalization hides."],
    a11y: [
      "The shared keyboard, hover and tap inspector reports both amount and share.",
      "A zero sum or missing observation interrupts the stack.",
    ],
    options: [
      { name: "normalize", type: "boolean", description: "Draw each complete nonzero stack as 100 %. Raw amounts remain available." },
    ],
  },
];
export default areaExamples;
