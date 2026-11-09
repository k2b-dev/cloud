// Generated from the chart showcase examples by scripts/generate-chart-catalog.ts. Do not edit.

/** One line per chart kind and layout for the chart tool: when to use it, when not, and a small valid description. */
export const chartCatalog = [
  {
    name: "waterfall",
    useFor: "Explain how ordered changes connect two balances.",
    avoidFor: "Unordered rankings or unrelated category values.",
    example: {
      kind: "waterfall",
      title: "October cash",
      start: { label: "1 Oct", value: 18800 },
      steps: [
        { label: "Sales", value: 29260 },
        { label: "Stock", value: -14800 },
        { label: "Payroll", value: -9600 },
      ],
      end: { label: "31 Oct" },
      format: { style: "currency", currency: "EUR", decimals: 0 },
    },
  },
  {
    name: 'area (layout "stacked")',
    useFor: "A changing total made up of nonnegative parts.",
    avoidFor: "Negative changes or many crossing series; use lines instead.",
    example: {
      kind: "area",
      layout: "stacked",
      x: ["Jan", "Feb", "Mar"],
      series: [
        { label: "Subscriptions", data: [120, 140, 130] },
        { label: "Projects", data: [180, 160, 170] },
        { label: "Training", data: [40, 50, 60] },
      ],
      title: "Studio sales",
    },
  },
  {
    name: "bar",
    useFor: "Comparing a handful of categories, such as channels, teams or regions.",
    avoidFor: "Long continuous time series; use a line chart.",
    example: {
      kind: "bar",
      title: "Signups by channel",
      data: [
        { label: "Search", value: 1840 },
        { label: "Mail", value: 1260 },
        { label: "Social", value: 920 },
      ],
      yAxis: { label: "Signups" },
      showValues: true,
    },
  },
  {
    name: 'bar (layout "grouped")',
    useFor: "Several series with matching categories",
    avoidFor: "Unaligned observations",
    example: {
      kind: "bar",
      title: "Orders by channel",
      x: ["Q1", "Q2", "Q3"],
      series: [
        { label: "Store", data: [350, 420, 510] },
        { label: "Web", data: [240, 310, 420] },
        { label: "Fair", data: [90, 120, 180] },
      ],
      layout: "grouped",
    },
  },
  {
    name: 'bar (layout "rows")',
    useFor: "Signed or positive category values",
    avoidFor: "A continuous time axis",
    example: {
      kind: "bar",
      title: "Orders by collection",
      layout: "rows",
      data: [
        { label: "Furniture", value: 84 },
        { label: "Lighting", value: 62 },
        { label: "Pictures", value: 39 },
      ],
    },
  },
  {
    name: 'bar (layout "stacked")',
    useFor: "Parts and their total",
    avoidFor: "Negative segments",
    example: {
      kind: "bar",
      title: "Orders and their total",
      x: ["Q1", "Q2", "Q3"],
      series: [
        { label: "Store", data: [350, 420, 510] },
        { label: "Web", data: [240, 310, 420] },
      ],
      layout: "stacked",
    },
  },
  {
    name: "hbar",
    useFor: "Grouped categories with long names",
    avoidFor: "Negative segments",
    example: {
      kind: "hbar",
      title: "Orders by category and channel",
      series: ["Q1", "Q2", "Q3"],
      rows: [
        { group: "Store", label: "Furniture", values: [35, 36, 50] },
        { group: "Store", label: "Lighting", values: [49, 46, 47] },
        { group: "Web", label: "Furniture", values: [50, 43, 39] },
      ],
    },
  },
  {
    name: "funnel",
    useFor: "A sequence of counts",
    avoidFor: "Negative values",
    example: {
      kind: "funnel",
      title: "Purchase journey",
      data: [
        { label: "Visits", value: 12000 },
        { label: "Products", value: 8400 },
        { label: "Basket", value: 3600 },
      ],
    },
  },
  {
    name: "line",
    useFor:
      "A value that changes continuously, such as visitors, revenue or response time. Forecasts add forecast, threshold, marker, zero, step and legendValues.",
    avoidFor: "Categories without an order, such as products or countries; use a bar chart.",
    example: {
      kind: "line",
      title: "Visitors per day",
      series: [
        {
          label: "This year",
          data: [
            { x: "2026-10-01", y: 1180 },
            { x: "2026-10-02", y: 1224 },
            { x: "2026-10-03", y: 1009 },
          ],
        },
        {
          label: "Last year",
          role: "reference",
          data: [
            { x: "2026-10-01", y: 1020 },
            { x: "2026-10-02", y: 1056 },
            { x: "2026-10-03", y: 869 },
          ],
        },
      ],
      yAxis: { format: { style: "number", compact: true } },
      xAxis: { format: { date: "day" } },
      legend: true,
      smooth: true,
    },
  },
  {
    name: "scatter",
    useFor: "Whether two measures move together.",
    avoidFor: "Values over time; use a line chart.",
    example: {
      kind: "scatter",
      title: "Order size and delivery time",
      series: [
        {
          label: "Standard",
          data: [
            { x: 2, y: 2.1 },
            { x: 4, y: 2.4 },
            { x: 5, y: 2.2 },
          ],
        },
        {
          label: "Express",
          data: [
            { x: 1, y: 1 },
            { x: 3, y: 1.1 },
            { x: 6, y: 1.2 },
          ],
        },
      ],
      xAxis: { label: "Items per order" },
      yAxis: { label: "Days to deliver" },
      legend: true,
    },
  },
  {
    name: "pie",
    useFor: "Two to five parts that add up to one meaningful total.",
    avoidFor: "Comparing parts of similar size; use bars.",
    example: {
      kind: "pie",
      title: "Visits by device",
      data: [
        { label: "Phone", value: 14820 },
        { label: "Desktop", value: 9240 },
        { label: "Tablet", value: 2110 },
      ],
      showLabels: true,
      legend: true,
    },
  },
  {
    name: "donut",
    useFor: "Parts of a budget or a total amount.",
    avoidFor: "Precise comparison of similar parts; use bars.",
    example: {
      kind: "donut",
      title: "Costs by category",
      data: [
        { label: "Purchasing", value: 14800 },
        { label: "Staff", value: 9600 },
        { label: "Rent", value: 3200 },
      ],
      format: { style: "currency", currency: "EUR" },
      legend: true,
    },
  },
  {
    name: "histogram",
    useFor: "The spread of one measure across many items.",
    avoidFor: "Few values; show them as points.",
    example: { kind: "histogram", title: "Order values", data: [12, 18, 19], bins: [0, 20, 40] },
  },
  {
    name: "gauge",
    useFor: "One value against a fixed limit, such as storage, quota or capacity.",
    avoidFor: "Values without a natural maximum.",
    example: {
      kind: "gauge",
      title: "Storage used",
      value: 1.46,
      min: 0,
      max: 2,
      unit: "TB",
      format: { decimals: 2 },
      thresholds: [
        { value: 1.4, label: "Plan more" },
        { value: 1.8, label: "Full soon" },
      ],
    },
  },
  {
    name: "sparkline",
    useFor: "The direction of a value next to the value itself.",
    avoidFor: "Exact values or dates; use a line chart with axes.",
    example: { kind: "sparkline", title: "Subscribers, last 12 weeks", data: [44120, 44380, 44210], area: true },
  },
  {
    name: "boxplot",
    useFor: "Comparing the spread of several groups.",
    avoidFor: "Readers who do not know box plots; a histogram or a short sentence may say more.",
    example: {
      kind: "boxplot",
      title: "Delivery time by carrier",
      data: [
        { label: "Carrier A", values: [1.2, 1.5, 1.8] },
        { label: "Carrier B", values: [1.9, 2.2, 2.5] },
        { label: "Carrier C", values: [0.9, 1, 1.1] },
      ],
      yAxis: { label: "Days" },
    },
  },
  {
    name: 'heatmap (layout "calendar")',
    useFor: "Daily observations and weekly patterns.",
    avoidFor: "Exact comparisons between close values.",
    example: {
      kind: "heatmap",
      layout: "calendar",
      title: "Opens per day",
      scale: "sequential",
      data: [
        ["2025-01-01", 0],
        ["2025-01-02", 17],
        ["2025-01-03", 34],
      ],
    },
  },
  {
    name: "heatmap",
    useFor: "Patterns across two categories, such as weekday and hour.",
    avoidFor: "Exact comparison of values; color is read only roughly.",
    example: {
      kind: "heatmap",
      title: "Newsletter opens by day and time",
      data: [
        { x: "6–9", y: "Mon", value: 120 },
        { x: "9–12", y: "Mon", value: 340 },
        { x: "12–15", y: "Mon", value: 260 },
      ],
    },
  },
  {
    name: "barGauge",
    useFor: "Usage of several accounts, rooms or machines against the same limit.",
    avoidFor: "Values without a shared maximum; use a bar chart.",
    example: {
      kind: "barGauge",
      title: "Mailbox quota",
      data: [
        { label: "Support", value: 8.7 },
        { label: "Sales", value: 6.2 },
        { label: "Accounting", value: 4.9 },
      ],
      min: 0,
      max: 10,
      unit: "GB",
      thresholds: [
        { value: 7, label: "Close" },
        { value: 9, label: "Full" },
      ],
    },
  },
  {
    name: "stat",
    useFor: "The one number a reader needs first, with its direction.",
    avoidFor: "Several equal numbers in a row; use key figure tiles.",
    example: {
      kind: "stat",
      title: "Revenue from the newsletter",
      value: 18420,
      format: { style: "currency", currency: "EUR" },
      delta: 2460,
      better: "up",
      sparkline: [11200, 12900, 12100],
    },
  },
  {
    name: "treemap",
    useFor: "Many nonnegative parts of one total, grouped by color.",
    avoidFor: "Negative values or precise comparisons between similar values.",
    example: {
      kind: "treemap",
      title: "Inventory by category",
      groups: ["Furniture", "Lights", "Art"],
      data: [
        { label: "Cabinets", group: "Furniture", value: 24000 },
        { label: "Tables", group: "Furniture", value: 16000 },
        { label: "Chairs", group: "Furniture", value: 11000 },
      ],
    },
  },
  {
    name: "pareto",
    useFor: "Finding the few categories that account for most of a total.",
    avoidFor: "Signed values or a time trend.",
    example: {
      kind: "pareto",
      title: "Revenue by region",
      labels: ["2026", "2025"],
      data: [
        { label: "North", value: 140000, prev: 120000 },
        { label: "East", value: 105000, prev: 97000 },
        { label: "South", value: 86000, prev: 90000 },
      ],
    },
  },
  {
    name: "bubble",
    useFor: "Comparing two measures and one nonnegative area measure for named observations.",
    avoidFor: "Precise ranking of many similarly sized bubbles.",
    example: {
      kind: "bubble",
      title: "Campaigns",
      groups: ["North", "South"],
      xLabel: "Visits",
      yLabel: "Opens",
      sizeLabel: "Audience",
      averages: true,
      data: [
        { label: "Letter A", group: "North", x: 120, y: 80, size: 400 },
        { label: "Letter B", group: "North", x: 240, y: 120, size: 900 },
        { label: "Letter C", group: "South", x: 180, y: 160, size: 600 },
      ],
    },
  },
  {
    name: "radar",
    useFor: "Comparing profiles on 3–8 axes with the same unit and maximum.",
    avoidFor: "Combining unrelated units or independently scaled axes.",
    example: {
      kind: "radar",
      title: "Plan scores",
      axes: ["Quality", "Speed", "Cost"],
      max: 5,
      unit: "points",
      series: [
        { label: "Plan A", data: [4, 3, 2] },
        { label: "Plan B", data: [2, 4, 4] },
      ],
    },
  },
  {
    name: "sankey",
    useFor: "Converging and diverging flows with a common unit.",
    avoidFor: "Cycles or unrelated measures; use bars for unrelated categories.",
    example: {
      kind: "sankey",
      title: "Paths after the click",
      nodes: [
        { id: "click", label: "Clicked", tone: "blue" },
        { id: "article", label: "Article", tone: "green" },
        { id: "offer", label: "Offer", tone: "violet" },
        { id: "signup", label: "Signed up", tone: "in" },
      ],
      links: [
        { source: "click", target: "article", value: 520 },
        { source: "click", target: "offer", value: 280 },
        { source: "article", target: "signup", value: 140 },
      ],
    },
  },
  {
    name: "balanceFlow",
    useFor: "Reconciled balances across consecutive settlement periods.",
    avoidFor: "Unreconciled or missing balances.",
    example: {
      kind: "balanceFlow",
      title: "Marketplace settlements",
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
  },
] as const;
