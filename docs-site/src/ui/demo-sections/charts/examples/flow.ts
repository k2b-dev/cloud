/** Showcase entries for money with a direction (`FlowAmount`); invented data only. */
export const flowExamples = [
  {
    id: "flow-amounts",
    kind: "flow",
    question: "numbers",
    title: "Money in and out",
    summary: "Turquoise comes in with an arrow down-left, violet goes out with an arrow up-right; no sign.",
    spec: [
      { type: "flow", value: 31240.5, currency: "EUR" },
      { type: "flow", value: -30500, currency: "EUR" },
      { type: "flow", value: 0, currency: "EUR" },
      { type: "flow", value: -1204.8, currency: "EUR", labels: { out: "Expense" } },
    ],
    width: "half",
    useFor: ["Bookings, transfers and cash flow", "Totals of a period that are clearly in or out"],
    avoidFor: ["A balance or net result (use Format.Currency)", "Status (use green and red badges)"],
    a11y: [
      "Each amount ends with a hidden word: “, incoming”, “, outgoing” or “, no amount”.",
      "The arrow is decorative; color is never the only signal.",
    ],
    options: [
      { name: "value", type: "number", description: "Signed amount: positive in, negative out, zero none." },
      { name: "currency", type: "string", description: "ISO 4217 code such as EUR." },
      { name: "labels", type: "{ in?, out? }", description: "The direction words screen readers hear." },
      { name: "decimals", type: "number", description: "Fixed fraction digits; defaults to the currency's digits." },
    ],
  },
];
