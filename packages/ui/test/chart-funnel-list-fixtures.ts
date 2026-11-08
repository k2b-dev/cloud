import type { ChartProps } from "../src/content/Chart";
import { signedRows069 } from "./chart-rows-069-fixture";
export const funnelListFixtures = [
  {
    kind: "funnel",
    data: [
      { label: "Visits", value: 12000 },
      { label: "Products", value: 8400 },
      { label: "Basket", value: 3600 },
      { label: "Orders", value: 1800 },
    ],
  },
  {
    kind: "bar",
    layout: "rows",
    share: true,
    limit: 4,
    tone: "out",
    data: [
      { label: "Delivery", value: 720 },
      { label: "Workspace", value: 2400 },
      { label: "Materials", value: 1600 },
      { label: "Power", value: 360 },
      { label: "Insurance", value: 280 },
      { label: "Repairs", value: 180 },
    ],
  },
  {
    kind: "funnel",
    data: [
      { label: "Starting group", value: 0 },
      { label: "New arrivals", value: 15 },
      { label: "Retained", value: 30 },
      { label: "Missing", value: null },
    ],
  },
  signedRows069,
] satisfies ChartProps[];
