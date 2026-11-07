import type { ChartShowcaseExample } from "./types";

export const balanceFlowExamples = [
  {
    id: "balance-flow-marketplace",
    kind: "balanceFlow",
    question: "flow",
    title: "A closing balance becomes next month's opening",
    summary:
      "Follow fictional marketplace settlements through three months. Every euro reconciles; the closing balance carries into the next opening.",
    spec: {
      kind: "balanceFlow",
      title: "Marketplace settlements",
      subtitle: "Fictional data · EUR",
      currency: "EUR",
      locale: "en-GB",
      periods: [
        {
          label: "October 2026",
          opening: 1200,
          inflows: [{ label: "Marketplace orders", value: 8400 }],
          outflows: [
            { label: "Cases", value: 120 },
            { label: "Refunds", value: 320 },
            { label: "Marketplace fees", value: 760 },
            { label: "Shipping labels", value: 400 },
            { label: "Payouts", value: 6000 },
          ],
          closing: 2000,
        },
        {
          label: "November 2026",
          opening: 2000,
          inflows: [{ label: "Marketplace orders", value: 7200 }],
          outflows: [
            { label: "Fees and shipping", value: 1200 },
            { label: "Payouts", value: 6500 },
          ],
          closing: 1500,
        },
        {
          label: "December 2026",
          opening: 1500,
          inflows: [{ label: "Marketplace orders", value: 10300 }],
          outflows: [
            { label: "Fees and shipping", value: 1800 },
            { label: "Payouts", value: 7000 },
          ],
          closing: 3000,
        },
      ],
    },
    height: 540,
    width: "full",
    useFor: [
      "Reconciled balances across consecutive settlement periods.",
      "Showing how receipts, deductions and payouts explain the remaining balance.",
    ],
    avoidFor: ["Unreconciled or missing balances.", "Unrelated measures or conversions between currencies."],
    a11y: [
      "Left/right arrows or Previous/Next change one period. Up/down inspect amounts; Enter pins, Escape dismisses.",
      "The period summary reads opening, inflows, outflows and closing. The table and phone rows retain every complete name and amount.",
      "The blue closing bar moves to the next opening position; reduced motion removes the movement.",
    ],
    options: [
      {
        name: "periods",
        type: "{label,opening,inflows,outflows,closing}[]",
        description:
          "In chronological order. Every equation must balance, and closing must equal the next opening exactly as decimal inputs.",
      },
      {
        name: "currency",
        type: "ISO 4217 string",
        description: "One currency for every amount, formatted without a sign. Negative balances explicitly say owed.",
      },
      { name: "period", type: "number", description: "Initial zero-based period; defaults to 0 on server and browser." },
      { name: "locale", type: "BCP 47 string", description: "Optional override of the inherited UI locale." },
    ],
  },
] satisfies ChartShowcaseExample[];
