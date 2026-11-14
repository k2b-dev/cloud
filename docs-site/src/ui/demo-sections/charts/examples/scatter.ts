import { axisOption, commonOptions, inspectA11y } from "./common";
import type { ChartShowcaseExample } from "./types";

const point = (x: number, y: number) => ({ x, y });

const examples: ChartShowcaseExample[] = [
  {
    id: "scatter-orders",
    kind: "scatter",
    question: "distribution",
    title: "Scatter plot",
    summary: "Two measures per item. Clusters, trends and outliers show at a glance.",
    spec: {
      kind: "scatter",
      title: "Order size and delivery time",
      subtitle: "Last 30 days · invented data",
      series: [
        {
          label: "Standard",
          data: [
            point(2, 2.1),
            point(4, 2.4),
            point(5, 2.2),
            point(8, 2.9),
            point(11, 3.1),
            point(14, 3.3),
            point(18, 3.8),
            point(21, 4.1),
            point(26, 4.0),
            point(30, 4.6),
          ],
        },
        {
          label: "Express",
          data: [
            point(1, 1.0),
            point(3, 1.1),
            point(6, 1.2),
            point(9, 1.4),
            point(12, 1.3),
            point(15, 1.7),
            point(19, 1.9),
            point(24, 2.2),
          ],
        },
      ],
      xAxis: { label: "Items per order" },
      yAxis: { label: "Days to deliver" },
      legend: true,
    },
    useFor: ["Whether two measures move together.", "Finding outliers among many items.", "Comparing two groups on the same two measures."],
    avoidFor: ["Values over time; use a line chart.", "Only one measure; use a histogram or box plot."],
    a11y: [
      "One tab stop: Tab focuses the chart, arrow keys move from point to point in drawing order, Home and End jump to the first and the last.",
      ...inspectA11y.slice(1),
    ],
    options: [
      ...commonOptions,
      {
        name: "series",
        type: "{ label?, data: { x, y }[], role? }[]",
        description: 'Groups of points; role "reference" draws hollow marks.',
      },
      axisOption("xAxis"),
      axisOption("yAxis"),
      { name: "references", type: "{ value, axis?, label? }[]", description: "Reference lines, such as an average." },
    ],
  },
];

export default examples;
