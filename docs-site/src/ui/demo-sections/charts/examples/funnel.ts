import type { ChartShowcaseExample } from "./types";

export const funnelExamples = [
  {
    id: "funnel-journey",
    kind: "funnel",
    question: "flow",
    title: "Purchase journey",
    summary: "Each step shows its share of the start; inspection also compares the previous step.",
    spec: {
      kind: "funnel",
      title: "Purchase journey",
      data: [
        { label: "Visits", value: 12000 },
        { label: "Products", value: 8400 },
        { label: "Basket", value: 3600 },
        { label: "Orders", value: 1800 },
      ],
    },
    height: 260,
    width: "half",
    useFor: ["A sequence of counts"],
    avoidFor: ["Negative values"],
    a11y: ["Arrows inspect steps; Enter pins and Escape dismisses.", "Values and both shares are available in the data table."],
    options: [
      {
        name: "data",
        type: "{label,value}[]",
        description: "Nonnegative counts; rising steps are allowed and zero denominators show a dash.",
      },
    ],
  },
  {
    id: "funnel-growth",
    kind: "funnel",
    question: "flow",
    title: "A growing cohort",
    summary: "Rising steps remain visible, with percentages above 100 percent.",
    spec: {
      kind: "funnel",
      title: "A growing cohort",
      data: [
        { label: "Original", value: 20 },
        { label: "With referrals", value: 35 },
        { label: "Retained", value: 28 },
      ],
    },
    height: 260,
    width: "half",
    useFor: ["Sequences that can gain participants"],
    avoidFor: ["Unrelated categories"],
    a11y: ["The tooltip names the start and previous-step denominators."],
    options: [{ name: "format", type: "NumberFormat", description: "Format the counts independently of their shares." }],
  },
] satisfies ChartShowcaseExample[];
