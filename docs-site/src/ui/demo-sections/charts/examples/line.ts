export const lineExamples = [
  {
    id: "line-forecast",
    kind: "line",
    question: "trend" as const,
    title: "Can the studio cover its next payments?",
    summary: "Invented cash balances combine observed values with a dashed forecast, a range, reserve threshold and today marker.",
    spec: {
      kind: "line",
      title: "Studio cash outlook",
      legend: true,
      zero: true,
      smooth: false,
      series: [
        {
          label: "Cash",
          data: [
            { x: 1, y: 32 },
            { x: 2, y: 28 },
            { x: 3, y: 36 },
            { x: 4, y: 22 },
            { x: 5, y: 15 },
            { x: 6, y: 8 },
            { x: 7, y: -3 },
            { x: 8, y: 12 },
            { x: 9, y: 24 },
          ],
        },
        {
          label: "Committed",
          data: [
            { x: 1, y: 24 },
            { x: 2, y: 22 },
            { x: 3, y: 26 },
            { x: 4, y: 18 },
            { x: 5, y: 10 },
            { x: 6, y: 4 },
            { x: 7, y: -6 },
            { x: 8, y: 7 },
            { x: 9, y: 16 },
          ],
        },
      ],
      forecast: {
        from: 5,
        band: [
          [11, 19],
          [2, 14],
          [-10, 4],
          [3, 21],
          [12, 36],
        ],
      },
      threshold: { value: 10, label: "Reserve" },
      marker: { at: 5, label: "Today" },
    },
    height: 280,
    width: "twoThirds" as const,
    useFor: ["Separate observed values from an outlook without losing their connection."],
    avoidFor: ["Represent certainty when the forecast range is unknown."],
    a11y: [
      "Arrow keys, Home and End inspect each X; Enter pins and Escape closes.",
      "The legend shows each series value at the cursor; null stays a gap.",
    ],
    options: [
      {
        name: "forecast",
        type: "{from:number|ISO,band?:[number,number][]}",
        description: "Dash from an existing X. Bounds match the first series suffix ordered by X, with lower ≤ upper.",
      },
      { name: "zero", type: "boolean", description: "Include zero and tint the area below it red." },
      { name: "threshold", type: "{value:number,label:string}", description: "A labelled dashed warning line." },
      { name: "marker", type: "{at:number|ISO,label:string}", description: "A labelled vertical marker, for example Today." },
      { name: "step", type: '"after"|"before"', description: "Draw horizontal steps rather than interpolated segments." },
    ],
  },
];
export default lineExamples;
