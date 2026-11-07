import type { JsonValue } from "./examples/types";
import { liquidityForecastSpec } from "./liquidity-forecast";

export type ShowcasePanel = {
  id: string;
  width: "third" | "half" | "twoThirds" | "full";
  /** Content height in pixels. */
  height: number;
  /** Content height on a phone, where the panel spans the whole width, when it needs less room there. */
  compactHeight?: number;
  empty: string;
  /** What the mockup shows here, named in the slot while this build cannot draw it yet. */
  intended: string;
  spec: JsonValue;
};
export type ShowcaseSection = { id: string; title: string; icon: string; panels: ShowcasePanel[] };
export type ShowcaseDashboard = {
  slug: string;
  eyebrow: string;
  title: string;
  asOf: string;
  summary: string;
  stats: JsonValue;
  sections: ShowcaseSection[];
};

// Deterministic invented values: the same on the server and in every browser.
const wave = (index: number, seed: number) =>
  Math.sin(index * 12.9898 + seed * 78.233) * 43758.5453 - Math.floor(Math.sin(index * 12.9898 + seed * 78.233) * 43758.5453);
const isoDay = (start: string, offset: number) => {
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

const months = ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"];
const opened = [0.441, 0.432, 0.455, 0.462, 0.448, 0.471, 0.466, 0.452, 0.478, 0.481, 0.461, 0.492];
const clicked = [0.172, 0.165, 0.181, 0.188, 0.176, 0.191, 0.186, 0.179, 0.195, 0.199, 0.204, 0.198];

export const newsletterDashboard: ShowcaseDashboard = {
  slug: "newsletter",
  eyebrow: "Pulse · Website",
  title: "Newsletter",
  asOf: "As of 6 Nov 2026, 09:40",
  summary:
    "A marketing dashboard: key figures on top, then what the newsletter achieves, what readers do after the click, every campaign and who reads.",
  stats: {
    block: "stats",
    items: [
      {
        label: "Subscribers",
        icon: "ti ti-users",
        value: 48210,
        delta: { value: 0.082, better: "up" },
        compare: { label: "Last month", value: 44560 },
        trend: [41200, 41900, 42400, 42100, 42900, 43600, 43300, 44100, 44560, 45900, 47100, 48210],
      },
      {
        label: "Open rate",
        icon: "ti ti-mail-opened",
        value: 0.492,
        format: { style: "percent", decimals: 1 },
        delta: { value: 0.031, unit: "points", better: "up" },
        compare: { label: "Last month", value: 0.461 },
      },
      {
        label: "Click rate",
        icon: "ti ti-click",
        value: 0.198,
        format: { style: "percent", decimals: 1 },
        delta: { value: -0.006, unit: "points", better: "up" },
        compare: { label: "Last month", value: 0.204 },
      },
      {
        label: "Unsubscribes",
        icon: "ti ti-user-minus",
        value: 182,
        delta: { value: -0.125, better: "down" },
        compare: { label: "Last month", value: 208 },
      },
    ],
  },
  sections: [
    {
      id: "effect",
      title: "Effect",
      icon: "ti ti-chart-dots-3",
      panels: [
        {
          id: "opens-clicks",
          intended: "Dot matrix with opens and clicks",
          width: "twoThirds",
          height: 300,
          empty: "No newsletter was sent in this period.",
          spec: {
            kind: "bar",
            title: "Opens and clicks",
            subtitle: "Per month · one dot is 5 % of recipients",
            x: months,
            layout: "nested",
            marks: "dots",
            // Shares of all recipients: 20 dots per month, one dot is 5 %.
            total: 1,
            dots: 20,
            series: [
              { label: "Opened", data: opened },
              { label: "Clicked", data: clicked },
            ],
            format: { style: "percent", decimals: 1 },
          },
        },
        {
          id: "revenue",
          intended: "Columns compared with the previous period",
          width: "third",
          height: 300,
          empty: "No revenue through newsletter links yet.",
          spec: {
            kind: "bar",
            title: "Newsletter revenue",
            subtitle: "October against September",
            x: ["1–7", "8–14", "15–21", "22–28", "29–31"],
            series: [{ label: "October", data: [3120, 4380, 3940, 4610, 2370] }],
            compare: { label: "September", data: [2980, 3640, 3420, 4010, 1910] },
            format: { style: "currency", currency: "EUR" },
          },
        },
      ],
    },
    {
      id: "after-click",
      title: "After the click",
      icon: "ti ti-route",
      panels: [
        {
          id: "funnel",
          intended: "Funnel",
          width: "third",
          height: 300,
          empty: "No campaign was sent in this period.",
          spec: {
            kind: "funnel",
            title: "Sending to buying",
            subtitle: "Weekly letter 44",
            data: [
              { label: "Sent", value: 46900 },
              { label: "Delivered", value: 46120 },
              { label: "Opened", value: 23075 },
              { label: "Clicked", value: 9290 },
              { label: "Bought", value: 412 },
            ],
          },
        },
        {
          id: "paths",
          intended: "Sankey",
          width: "twoThirds",
          height: 300,
          empty: "Nobody clicked a link in this period.",
          spec: {
            kind: "sankey",
            title: "Paths after the click",
            subtitle: "October · campaign, page, result",
            nodes: [
              { id: "weekly", label: "Weekly letter 44" },
              { id: "new", label: "New in stock" },
              { id: "autumn", label: "Autumn selection" },
              { id: "products", label: "Product pages" },
              { id: "blog", label: "Blog" },
              { id: "fair", label: "Trade fair" },
              { id: "buy", label: "Purchase", tone: "in" },
              { id: "wish", label: "Wish list" },
              { id: "signup", label: "Fair sign-up" },
              { id: "left", label: "Left", tone: "muted" },
            ],
            links: [
              { source: "weekly", target: "products", value: 2600 },
              { source: "weekly", target: "blog", value: 1200 },
              { source: "weekly", target: "fair", value: 400 },
              { source: "new", target: "products", value: 2300 },
              { source: "new", target: "blog", value: 700 },
              { source: "new", target: "fair", value: 300 },
              { source: "autumn", target: "products", value: 500 },
              { source: "autumn", target: "blog", value: 200 },
              { source: "autumn", target: "fair", value: 1090 },
              { source: "products", target: "buy", value: 392 },
              { source: "products", target: "wish", value: 1180 },
              { source: "products", target: "left", value: 3828 },
              { source: "blog", target: "buy", value: 20 },
              { source: "blog", target: "left", value: 2080 },
              { source: "fair", target: "signup", value: 640 },
              { source: "fair", target: "left", value: 1150 },
            ],
          },
        },
      ],
    },
    {
      id: "campaigns",
      title: "Campaigns",
      icon: "ti ti-send",
      panels: [
        {
          id: "campaign-table",
          intended: "Table",
          width: "full",
          height: 260,
          empty: "No campaign in this period.",
          spec: {
            block: "table",
            title: "Campaigns",
            subtitle: "Latest 6 of 38 · sortable",
            columns: [
              { id: "name", label: "Campaign", type: "text" },
              {
                id: "status",
                label: "Status",
                type: "status",
                states: {
                  sending: { label: "Sending", tone: "running" },
                  delivered: { label: "Delivered", tone: "ok" },
                  planned: { label: "Planned", tone: "neutral" },
                  overdue: { label: "Overdue", tone: "error" },
                  expected: { label: "Expected", tone: "running" },
                },
              },
              { id: "sent", label: "Sent", type: "date" },
              { id: "recipients", label: "Recipients", type: "number" },
              { id: "opened", label: "Opened", type: "number", format: { style: "percent", decimals: 1 } },
              { id: "clicked", label: "Clicked", type: "number", format: { style: "percent", decimals: 1 } },
              { id: "revenue", label: "Revenue", type: "amount", format: { style: "currency", currency: "EUR" } },
            ],
            rows: [
              {
                name: "Autumn selection",
                status: "sending",
                sent: "2026-11-06",
                recipients: 46900,
                opened: 0.314,
                clicked: 0.092,
                revenue: 2140,
              },
              {
                name: "Weekly letter 44",
                status: "delivered",
                sent: "2026-10-29",
                recipients: 46720,
                opened: 0.492,
                clicked: 0.198,
                revenue: 4610,
              },
              {
                name: "New in stock",
                status: "delivered",
                sent: "2026-10-22",
                recipients: 46510,
                opened: 0.526,
                clicked: 0.221,
                revenue: 6380,
              },
              {
                name: "Trade fair invitation",
                status: "planned",
                sent: "2026-11-12",
                recipients: 47000,
                opened: null,
                clicked: null,
                revenue: null,
              },
              {
                name: "Weekly letter 43",
                status: "delivered",
                sent: "2026-10-15",
                recipients: 46300,
                opened: 0.479,
                clicked: 0.187,
                revenue: 3950,
              },
              {
                name: "Weekly letter 42",
                status: "delivered",
                sent: "2026-10-08",
                recipients: 46080,
                opened: 0.468,
                clicked: 0.181,
                revenue: 3720,
              },
            ],
            search: true,
          },
        },
      ],
    },
    {
      id: "audience",
      title: "Audience",
      icon: "ti ti-users-group",
      panels: [
        {
          id: "opens-per-day",
          intended: "Calendar heatmap",
          width: "twoThirds",
          height: 200,
          empty: "No opens in this period.",
          spec: {
            kind: "heatmap",
            layout: "calendar",
            title: "Opens per day",
            subtitle: "Last 26 weeks · the weekly letter goes out on Thursdays",
            scale: "sequential",
            data: Array.from({ length: 182 }, (_, index) => {
              const weekday = index % 7;
              const base = weekday === 3 ? 5200 : weekday >= 5 ? 900 : 1900;
              return [isoDay("2026-05-11", index), Math.round(base * (0.8 + wave(index, 1) * 0.4))];
            }),
          },
        },
        {
          id: "countries",
          intended: "Bar list with shares",
          width: "third",
          height: 200,
          compactHeight: 200,
          empty: "No opens in this period.",
          spec: {
            kind: "bar",
            layout: "rows",
            title: "Opens by country",
            subtitle: "October",
            share: true,
            limit: 5,
            data: [
              { label: "Germany", value: 14120 },
              { label: "Austria", value: 3240 },
              { label: "Switzerland", value: 2540 },
              { label: "Netherlands", value: 1150 },
              { label: "France", value: 690 },
              { label: "Belgium", value: 420 },
              { label: "Denmark", value: 230 },
              { label: "Italy", value: 150 },
            ],
          },
        },
      ],
    },
  ],
};

export const liquidityDashboard: ShowcaseDashboard = {
  slug: "liquidity",
  eyebrow: "Code page · from the catalog only",
  title: "Liquidity",
  asOf: "As of 6 Nov 2026, 09:40 · forecast from planned payments",
  summary:
    "A finance dashboard: the balance today and its forecast, how October went from start to end, where money came from and went, November's budgets and the next payments.",
  stats: {
    block: "stats",
    items: [
      {
        label: "Balance today",
        icon: "ti ti-building-bank",
        value: 21140,
        format: { style: "currency", currency: "EUR", decimals: 0 },
        delta: { value: -0.047, better: "up" },
        compare: { label: "30 days ago", value: 22180 },
      },
      {
        label: "Lowest in 60 days",
        icon: "ti ti-alert-triangle",
        tone: "warning",
        value: 6650,
        format: { style: "currency", currency: "EUR", decimals: 0 },
        note: "Expected on 1 Dec · threshold 10,000 €",
      },
      {
        label: "In, October",
        icon: "ti ti-arrow-down-left",
        type: "flow",
        direction: "in",
        value: 29260,
        format: { style: "currency", currency: "EUR", decimals: 0 },
        delta: { value: 0.065 },
        compare: { label: "September", value: 27480 },
      },
      {
        label: "Out, October",
        icon: "ti ti-arrow-up-right",
        type: "flow",
        direction: "out",
        value: 29520,
        format: { style: "currency", currency: "EUR", decimals: 0 },
        delta: { value: 0.051 },
        compare: { label: "September", value: 28100 },
      },
    ],
  },
  sections: [
    {
      id: "balance",
      title: "Balance and forecast",
      icon: "ti ti-chart-line",
      panels: [
        {
          id: "balance-line",
          intended: "Line with forecast, range, threshold and today",
          width: "full",
          height: 280,
          empty: "No account is connected yet.",
          spec: liquidityForecastSpec,
        },
      ],
    },
    {
      id: "october",
      title: "October",
      icon: "ti ti-calendar-month",
      panels: [
        {
          id: "waterfall",
          intended: "Waterfall",
          width: "twoThirds",
          height: 280,
          empty: "No bookings in October.",
          spec: {
            kind: "waterfall",
            title: "October in steps",
            subtitle: "Business account · start to end of month",
            start: { label: "1 Oct", value: 18800 },
            steps: [
              { label: "Sales", value: 29260 },
              { label: "Purchasing", value: -14800 },
              { label: "Staff", value: -9600 },
              { label: "Rent", value: -3200 },
              { label: "Other", value: -1920 },
            ],
            end: { label: "31 Oct" },
            format: { style: "currency", currency: "EUR" },
          },
        },
        {
          id: "out-by-category",
          intended: "Bar list with shares",
          width: "third",
          height: 280,
          compactHeight: 160,
          empty: "Nothing went out in October.",
          spec: {
            kind: "bar",
            layout: "rows",
            title: "Out by category",
            subtitle: "October 2026",
            share: true,
            tone: "out",
            data: [
              { label: "Purchasing", value: 14800 },
              { label: "Staff", value: 9600 },
              { label: "Rent", value: 3200 },
              { label: "Other", value: 1920 },
            ],
          },
        },
        {
          id: "sankey",
          intended: "Sankey",
          width: "full",
          height: 280,
          empty: "No bookings in October.",
          spec: {
            kind: "sankey",
            title: "In and out",
            subtitle: "October 2026 · where from and where to",
            nodes: [
              { id: "shop", label: "Shop", tone: "in" },
              { id: "web", label: "Web shop", tone: "in" },
              { id: "fair", label: "Trade fair", tone: "in" },
              { id: "reserve", label: "From the balance", tone: "muted" },
              { id: "month", label: "Money in October" },
              { id: "purchasing", label: "Purchasing", tone: "out" },
              { id: "staff", label: "Staff", tone: "out" },
              { id: "rent", label: "Rent", tone: "out" },
              { id: "other", label: "Other", tone: "out" },
              { id: "wages", label: "Net wages", tone: "out" },
              { id: "tax", label: "Wage tax", tone: "tax" },
              { id: "social", label: "Social security", tone: "tax" },
            ],
            links: [
              { source: "shop", target: "month", value: 16090 },
              { source: "web", target: "month", value: 10240 },
              { source: "fair", target: "month", value: 2930 },
              { source: "reserve", target: "month", value: 260 },
              { source: "month", target: "purchasing", value: 14800 },
              { source: "month", target: "staff", value: 9600 },
              { source: "month", target: "rent", value: 3200 },
              { source: "month", target: "other", value: 1920 },
              { source: "staff", target: "wages", value: 6480 },
              { source: "staff", target: "tax", value: 1420 },
              { source: "staff", target: "social", value: 1700 },
            ],
          },
        },
      ],
    },
    {
      id: "november",
      title: "November",
      icon: "ti ti-calendar-event",
      panels: [
        {
          id: "budgets",
          intended: "Budget",
          width: "third",
          height: 300,
          empty: "No budget is set for November.",
          spec: {
            block: "budget",
            title: "Budgets in November",
            subtitle: "Booked and expected",
            currency: "EUR",
            items: [
              { label: "Purchasing", used: 11400, expected: 5800, limit: 18000 },
              { label: "Advertising", used: 1100, expected: 740, limit: 2000 },
              { label: "Travel", used: 1650, expected: 0, limit: 1500 },
              { label: "Office", used: 310, expected: 0, limit: 800 },
            ],
          },
        },
        {
          id: "next-payments",
          intended: "Table",
          width: "twoThirds",
          height: 300,
          empty: "No payments are planned.",
          spec: {
            block: "table",
            title: "Next payments",
            subtitle: "6 of 14 · until 4 Jan 2027",
            columns: [
              { id: "due", label: "Due", type: "date" },
              { id: "payment", label: "Payment", type: "text" },
              { id: "category", label: "Category", type: "text", priority: 3 },
              {
                id: "status",
                label: "Status",
                type: "status",
                states: {
                  sending: { label: "Sending", tone: "running" },
                  delivered: { label: "Delivered", tone: "ok" },
                  planned: { label: "Planned", tone: "neutral" },
                  overdue: { label: "Overdue", tone: "error" },
                  expected: { label: "Expected", tone: "running" },
                },
              },
              { id: "amount", label: "Amount", type: "flow", format: { style: "currency", currency: "EUR" } },
            ],
            rows: [
              { due: "2026-11-03", payment: "Liability insurance", category: "Insurance", status: "overdue", amount: -420 },
              { due: "2026-11-09", payment: "Invoice 2026-118", category: "Customer payment", status: "expected", amount: 2380 },
              { due: "2026-11-12", payment: "Autumn purchase", category: "Purchasing", status: "planned", amount: -7400 },
              { due: "2026-11-20", payment: "Sales tax", category: "Taxes", status: "planned", amount: -5900 },
              { due: "2026-11-26", payment: "Christmas purchase", category: "Purchasing", status: "planned", amount: -9800 },
              { due: "2026-11-27", payment: "November wages", category: "Staff", status: "planned", amount: -9600 },
            ],
          },
        },
      ],
    },
    {
      id: "look-back",
      title: "Look back",
      icon: "ti ti-history",
      panels: [
        {
          id: "net-per-day",
          intended: "Calendar heatmap, diverging",
          width: "full",
          height: 200,
          empty: "No bookings in this period.",
          spec: {
            kind: "heatmap",
            layout: "calendar",
            title: "Net per day",
            subtitle: "Last 26 weeks · in minus out",
            scale: "diverging",
            data: Array.from({ length: 182 }, (_, index) => [isoDay("2026-05-11", index), Math.round((wave(index, 2) - 0.45) * 4200)]),
          },
        },
      ],
    },
  ],
};

export const showcaseDashboards = [newsletterDashboard, liquidityDashboard] as const;
export const showcaseDashboard = (slug: string) => showcaseDashboards.find((dashboard) => dashboard.slug === slug);
