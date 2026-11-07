/** Showcase entries for budgets (`BudgetList` on the segmented `ProgressBar`); invented data only. */
export const budgetExamples = [
  {
    id: "budget-categories",
    kind: "budget",
    question: "numbers",
    title: "Budgets by category",
    summary: "Booked solid, expected hatched, over the budget red with a mark at the limit; amber from 80 %.",
    spec: {
      block: "budget",
      currency: "EUR",
      items: [
        { label: "Wareneinkauf", used: 9200, expected: 1800, limit: 15000 },
        { label: "Marketing", used: 1400, expected: 300, limit: 2000 },
        { label: "Reisen", used: 900, expected: 300, limit: 1000 },
        { label: "Software", used: 380, limit: 600 },
      ],
    },
    width: "third",
    useFor: ["Spending against a budget per category or person", "Quotas with booked and expected use"],
    avoidFor: ["Progress of a task (use ProgressBar with a value)", "Comparing categories without a limit (use a bar list)"],
    a11y: [
      "Each bar is a progressbar whose spoken value names booked, expected and the budget.",
      "Hover or keyboard focus on a row shows the breakdown; the hint says what is left or over in words, so colour is never the only signal.",
    ],
    options: [
      {
        name: "items",
        type: "{ label, used, expected?, limit }[]",
        description: "used is booked; expected comes on top; over = used + expected − limit.",
      },
      { name: "currency", type: "string", description: "ISO 4217 code; amounts use the inherited locale." },
      { name: "decimals", type: "number", description: "Fixed fraction digits, 0 by default." },
      { name: "empty", type: "string", description: "Sentence shown when there is no budget." },
    ],
  },
];
