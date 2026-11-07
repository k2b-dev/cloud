/** Showcase entries for the balance row (`BalanceSummary`); invented data only. */
export const balanceExamples = [
  {
    id: "balance-month",
    kind: "balance",
    question: "numbers",
    title: "From start to end of the month",
    summary: "Start + in − out = end, with in and out showing their direction.",
    spec: { block: "balance", start: 18800, in: 29260, out: 29520, currency: "EUR" },
    width: "twoThirds",
    useFor: ["The head line of a cash flow or waterfall panel", "A period summary in a report"],
    avoidFor: ["More than one account in one line (one row per account)"],
    a11y: ["Operators are hidden; screen readers hear “Anfang 18.800 €, 29.260 €, rein, 29.520 €, raus, Ende 18.540 €”."],
    options: [
      { name: "start", type: "number", description: "Balance at the start of the period." },
      { name: "in / out", type: "number", description: "Money in and out as amounts; signs are ignored." },
      { name: "currency", type: "string", description: "ISO 4217 code." },
      { name: "labels", type: "{ start?, end?, in?, out? }", description: "Replaces the words." },
    ],
  },
];
