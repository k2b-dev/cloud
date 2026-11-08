import type { ChartDescription } from "../src/charts/description";

/** Frozen accepted Cloud 0.69 shape (cloud-v0.69.0); keep it free of later ranked-list options. */
export const signedRows069 = {
  kind: "bar",
  title: "Inventory adjustments",
  layout: "rows",
  data: [
    { label: "Returns", value: -12 },
    { label: "Sales", value: 30 },
    { label: "Correction", value: -4 },
    { label: "Unchanged", value: 0 },
  ],
} satisfies ChartDescription;
