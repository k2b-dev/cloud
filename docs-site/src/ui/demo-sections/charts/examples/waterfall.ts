export const waterfallExamples = [
  {
    id: "waterfall-cash",
    kind: "waterfall",
    question: "flow" as const,
    title: "From opening to closing balance",
    summary: "Follow receipts and payments through an invented shop's month. Turquoise adds money; violet removes it.",
    spec: {
      kind: "waterfall",
      title: "October cash",
      start: { label: "1 Oct", value: 18800 },
      steps: [
        { label: "Sales", value: 29260 },
        { label: "Stock", value: -14800 },
        { label: "Payroll", value: -9600 },
        { label: "Rent", value: -3200 },
        { label: "Other", value: -1920 },
      ],
      end: { label: "31 Oct" },
      format: { style: "currency", currency: "EUR", decimals: 0 },
    },
    height: 280,
    width: "twoThirds" as const,
    useFor: ["Explain how ordered changes connect two balances."],
    avoidFor: ["Unordered rankings or unrelated category values."],
    a11y: [
      "Arrow keys, Home and End inspect every step, including labels omitted on a phone.",
      "Enter pins a tooltip; Escape dismisses it. Tap selects without claiming scrolling.",
      "Each tooltip and the data table include the amount and the running balance before and after.",
    ],
    options: [
      { name: "start", type: "{label:string,value:number}", description: "Opening total, drawn from zero." },
      {
        name: "steps",
        type: "{label:string,value:number}[]",
        description: "Ordered finite signed changes. Zero is a real unchanged step; null is rejected.",
      },
      { name: "end", type: "{label:string}", description: "Closing total calculated from the opening balance and all changes." },
      { name: "format", type: "NumberFormat", description: "Named number or currency format for portable JSON." },
    ],
  },
];
export default waterfallExamples;
