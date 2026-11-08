import { axisOption, commonOptions, inspectA11y } from "./common";
import type { ChartShowcaseExample } from "./types";

const examples: ChartShowcaseExample[] = [
  {
    id: "bar-signups",
    kind: "bar",
    question: "compare",
    title: "Bar chart",
    summary: "Compare categories side by side. Short labels stand as columns; long labels turn into one row per category.",
    spec: {
      kind: "bar",
      title: "Signups by channel",
      subtitle: "October · invented data",
      data: [
        { label: "Search", value: 1840 },
        { label: "Mail", value: 1260 },
        { label: "Social", value: 920 },
        { label: "Ads", value: 610 },
        { label: "Fairs", value: 340 },
      ],
      yAxis: { label: "Signups" },
      showValues: true,
    },
    lead: true,
    useFor: [
      "Comparing a handful of categories, such as channels, teams or regions.",
      "Rankings: sort the data so the largest category comes first.",
      "Several series per category, side by side or stacked to a total.",
      "This period against the last one, category by category.",
    ],
    avoidFor: [
      "Long continuous time series; use a line chart.",
      "Parts of one whole; use a donut.",
      "Changes that build on each other; use a waterfall.",
      "Negative values in a stack; stacked bars need zero or more.",
    ],
    a11y: [...inspectA11y, "Pointing anywhere in a column keeps that category; a light band shows which one."],
    options: [
      ...commonOptions,
      { name: "data", type: "{ label, value }[]", description: "One value per category; a missing value is null." },
      { name: "x", type: "string[]", description: "The categories several series share." },
      { name: "series", type: "{ label, data }[]", description: "One value per category in each series; pairs with x." },
      {
        name: "layout",
        type: '"columns" | "rows"',
        description:
          'Columns by default, rows for long labels; with several series grouped side by side or stacked to a total; nested draws a dot matrix with marks: "dots".',
      },
      { name: "xAxis", type: "{ label? }", description: "Names the categories." },
      axisOption("yAxis"),
      { name: "showValues", type: "boolean", description: "Prints each value at its bar." },
      { name: "colorByBar", type: "boolean", description: "Gives every bar its own palette color; pair it with legend." },
      { name: "references", type: "{ value, label? }[]", description: "Labelled reference lines, such as an average." },
    ],
  },
  {
    id: "bar-regions",
    kind: "bar",
    question: "compare",
    title: "Long names as rows",
    summary: "When the names do not fit under the columns on a phone, every category gets its own row with its value.",
    spec: {
      kind: "bar",
      title: "Revenue by sales region",
      subtitle: "Third quarter · in euros",
      data: [
        { label: "Northwestern coastal region", value: 184000 },
        { label: "Southern lake district", value: 142500 },
        { label: "Eastern uplands", value: 97000 },
        { label: "Central metropolitan area", value: 88400 },
      ],
      yAxis: { format: { style: "currency", currency: "EUR", compact: true } },
      showValues: true,
    },
    useFor: ["Categories with long names.", "Rankings that people read top to bottom."],
    avoidFor: ["Dozens of categories; show the largest and sum up the rest."],
    a11y: inspectA11y,
    options: [{ name: "yAxis.format", type: "NumberFormat", description: "Currency, percent or compact numbers for the values." }],
  },
];

export default examples;
