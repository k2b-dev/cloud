<!-- Generated from the chart showcase examples by scripts/generate-chart-catalog.ts. Do not edit. -->

# Chart kinds

Each kind with when to use it, its options and one small valid description. The
options are those of `cloud.chart()` in apps, scripts and PDFs; every kind also takes
`title`, `subtitle` and `tooltip` ([Charts](charts.md)). `await cloud.view.chart()`
and the `chart` tool take the same descriptions within the chat's limits: labels are
text, lists are shorter ([Views in the chat](views.md)), and an option notes where they
need a number instead of null. Every example below is valid on all three.

## waterfall

Use for: Explain how ordered changes connect two balances.

Avoid for: Unordered rankings or unrelated category values.

- `start` ({label:string,value:number}): Opening total, drawn from zero.
- `steps` ({label:string,value:number}[]): Ordered finite signed changes. Zero is a real unchanged step; null is rejected.
- `end` ({label:string}): Closing total calculated from the opening balance and all changes.
- `format` (NumberFormat): Named number or currency format for portable JSON.

```json
{"kind":"waterfall","title":"October cash","start":{"label":"1 Oct","value":18800},"steps":[{"label":"Sales","value":29260},{"label":"Stock","value":-14800},{"label":"Payroll","value":-9600}],"end":{"label":"31 Oct"},"format":{"style":"currency","currency":"EUR","decimals":0}}
```

## area (layout "stacked")

Use for: A changing total made up of nonnegative parts.

Avoid for: Negative changes or many crossing series; use lines instead.

- `layout` ("stacked"): Accumulate nonnegative source values at each X position.
- `x` ((string | number)[]): Ordered coordinates shared by all series. Every series has the same length.
- `series` ({label:string,data:(number|null)[]}[]): Amounts, with null for missing observations.

```json
{"kind":"area","layout":"stacked","x":["Jan","Feb","Mar"],"series":[{"label":"Subscriptions","data":[120,140,130]},{"label":"Projects","data":[180,160,170]},{"label":"Training","data":[40,50,60]}],"title":"Studio sales"}
```

## bar

Use for: Comparing a handful of categories, such as channels, teams or regions. Rankings: sort the data so the largest category comes first. Several series per category, side by side or stacked to a total. This period against the last one, category by category.

Avoid for: Long continuous time series; use a line chart. Parts of one whole; use a donut. Changes that build on each other; use a waterfall. Negative values in a stack; stacked bars need zero or more.

- `data` ({ label, value }[]): One value per category; a missing value is null. Views and the chart tool need a number here.
- `x` (string[]): The categories several series share.
- `series` ({ label, data }[]): One value per category in each series; pairs with x.
- `layout` ("columns" | "rows" | "grouped" | "stacked"): Columns by default, rows for long labels; with several series grouped side by side or stacked to a total.
- `xAxis` ({ label? }): Names the categories.
- `yAxis` ({ label?, domain?, ticks?, scale?, format? }): Vertical axis: label, exact [min, max], tick count, "log" scale and a number or date format.
- `showValues` (boolean): Prints each value at its bar.
- `colorByBar` (boolean): Gives every bar its own palette color; pair it with legend.
- `references` ({ value, label? }[]): Labelled reference lines, such as an average.

```json
{"kind":"bar","title":"Signups by channel","subtitle":"October · invented data","data":[{"label":"Search","value":1840},{"label":"Mail","value":1260},{"label":"Social","value":920}],"yAxis":{"label":"Signups"},"showValues":true}
```

## bar (layout "grouped")

Use for: Several series with matching categories

Avoid for: Unaligned observations

- `layout` ("columns" | "rows" | "grouped" | "stacked"): Place series next to each other or accumulate positive segments.

```json
{"kind":"bar","title":"Orders by channel","x":["Q1","Q2","Q3"],"series":[{"label":"Store","data":[350,420,510]},{"label":"Web","data":[240,310,420]},{"label":"Fair","data":[90,120,180]}],"layout":"grouped"}
```

## bar (layout "rows")

Use for: Signed or positive category values

Avoid for: A continuous time axis

- `layout` ("columns" | "rows" | "grouped" | "stacked"): Signed rows diverge around zero. Ordered categories, references, colorByBar, showValues and axis settings keep the original row drawing; otherwise nonnegative rows rank descending. Share, limit and tone require nonnegative values.

```json
{"kind":"bar","title":"Orders by collection","layout":"rows","data":[{"label":"Furniture","value":84},{"label":"Lighting","value":62},{"label":"Pictures","value":39}]}
```

## bar (layout "stacked")

Use for: Parts and their total

Avoid for: Negative segments

- `normalize` (boolean): Show shares of each category; zero totals are gaps.

```json
{"kind":"bar","title":"Orders and their total","x":["Q1","Q2","Q3"],"series":[{"label":"Store","data":[350,420,510]},{"label":"Web","data":[240,310,420]}],"layout":"stacked"}
```

## hbar

Use for: Grouped categories with long names

Avoid for: Negative segments

- `rows` ({ group?, label, values }[]): Nonnegative aligned segment values, with optional group headings.

```json
{"kind":"hbar","title":"Orders by category and channel","series":["Q1","Q2","Q3"],"rows":[{"group":"Store","label":"Furniture","values":[35,36,50]},{"group":"Store","label":"Lighting","values":[49,46,47]},{"group":"Web","label":"Furniture","values":[50,43,39]}]}
```

## funnel

Use for: A sequence of counts

Avoid for: Negative values

- `data` ({label,value}[]): Nonnegative counts; rising steps are allowed and zero denominators show a dash.

```json
{"kind":"funnel","title":"Purchase journey","data":[{"label":"Visits","value":12000},{"label":"Products","value":8400},{"label":"Basket","value":3600}]}
```

## line

Use for: A value that changes continuously, such as visitors, revenue or response time. Forecasts add forecast, threshold, marker, zero, step and legendValues. Up to four series on one scale, such as this year against last year. Many points: a line stays readable where columns would turn into stripes.

Avoid for: Categories without an order, such as products or countries; use a bar chart. Two values with different units; draw two charts instead of a second axis. A single number; use a key figure.

- `series` ({ label?, data: { x, y }[], role?, style? }[]): Series of points; x is a number or ISO date, a missing y is null and leaves a gap. role "reference" draws a comparison series dashed. Views and the chart tool need a number here.
- `xAxis` ({ label?, domain?, ticks?, scale?, format? }): Horizontal axis: label, exact [min, max], tick count, "log" scale and a number or date format.
- `yAxis` ({ label?, domain?, ticks?, scale?, format? }): Vertical axis: label, exact [min, max], tick count, "log" scale and a number or date format.
- `smooth` (boolean): Draws a smooth curve through the points.
- `area` (boolean): Fills the area under the first series.
- `references` ({ value, axis?, label? }[]): Labelled reference lines, such as a target.
- `legend` (boolean): Names the series; on by default with more than one series.
- `legendValues` (boolean): Opt in to cursor values without annotations; existing specs retain their legends.
- `forecast` ({from:number|ISO,band?:[number,number][]}): Dash from an existing X. Bounds match the first series suffix ordered by X, with lower ≤ upper.
- `zero` (boolean): Include zero and tint the area below it red.
- `threshold` ({value:number,label:string}): A labelled dashed warning line.
- `marker` ({at:number|ISO,label:string}): A labelled vertical marker, for example Today.
- `step` ("after" | "before" | "middle"): Draw horizontal steps rather than interpolated segments.

```json
{"kind":"line","title":"Visitors per day","subtitle":"Website · October · invented data","series":[{"label":"This year","data":[{"x":"2026-10-01","y":1180},{"x":"2026-10-02","y":1224},{"x":"2026-10-03","y":1009}]},{"label":"Last year","role":"reference","data":[{"x":"2026-10-01","y":1020},{"x":"2026-10-02","y":1056},{"x":"2026-10-03","y":869}]}],"yAxis":{"format":{"style":"number","compact":true}},"xAxis":{"format":{"date":"day"}},"legend":true,"smooth":true}
```

## scatter

Use for: Whether two measures move together. Finding outliers among many items. Comparing two groups on the same two measures.

Avoid for: Values over time; use a line chart. Only one measure; use a histogram or box plot.

- `series` ({ label?, data: { x, y }[], role? }[]): Groups of points; role "reference" draws hollow marks.
- `xAxis` ({ label?, domain?, ticks?, scale?, format? }): Horizontal axis: label, exact [min, max], tick count, "log" scale and a number or date format.
- `yAxis` ({ label?, domain?, ticks?, scale?, format? }): Vertical axis: label, exact [min, max], tick count, "log" scale and a number or date format.
- `references` ({ value, axis?, label? }[]): Reference lines, such as an average.

```json
{"kind":"scatter","title":"Order size and delivery time","subtitle":"Last 30 days · invented data","series":[{"label":"Standard","data":[{"x":2,"y":2.1},{"x":4,"y":2.4},{"x":5,"y":2.2}]},{"label":"Express","data":[{"x":1,"y":1},{"x":3,"y":1.1},{"x":6,"y":1.2}]}],"xAxis":{"label":"Items per order"},"yAxis":{"label":"Days to deliver"},"legend":true}
```

## pie

Use for: Two to five parts that add up to one meaningful total.

Avoid for: Comparing parts of similar size; use bars. More than six parts; group the small ones as “Other”. Changes over time.

- `data` ({ label, value }[]): Parts of the total; only values of zero and above.
- `showLabels` (boolean): Prints the share on large enough slices.
- `legend` (boolean): Names the slices below the chart.
- `format` ({ style?, currency?, unit?, decimals?, compact? }): Number format by name (style "number", "percent" or "currency") with an ISO currency, decimals and compact notation.

```json
{"kind":"pie","title":"Visits by device","subtitle":"October · invented data","data":[{"label":"Phone","value":14820},{"label":"Desktop","value":9240},{"label":"Tablet","value":2110}],"showLabels":true,"legend":true}
```

## donut

Use for: Parts of a budget or a total amount. Dashboards where several shares sit next to each other.

Avoid for: Precise comparison of similar parts; use bars. Parts that do not add up to a whole.

- `data` ({ label, value }[]): Parts of the total; only values of zero and above.
- `format` ({ style?, currency?, unit?, decimals?, compact? }): Number format by name (style "number", "percent" or "currency") with an ISO currency, decimals and compact notation.
- `legend` (boolean): Names the parts below the ring.

```json
{"kind":"donut","title":"Costs by category","subtitle":"October · in euros","data":[{"label":"Purchasing","value":14800},{"label":"Staff","value":9600},{"label":"Rent","value":3200}],"format":{"style":"currency","currency":"EUR"},"legend":true}
```

## histogram

Use for: The spread of one measure across many items. Spotting skew, gaps and a second peak.

Avoid for: Few values; show them as points. Comparing groups; use box plots side by side.

- `data` (number[]): The raw values.
- `bins` (number | number[]): A bin count or ascending bin edges.
- `references` ({ value, label? }[]): Reference lines, such as the median.

```json
{"kind":"histogram","title":"Order values","subtitle":"Last 30 days · in euros","data":[12,18,19],"bins":[0,20,40],"tooltip":{"label":"Orders"}}
```

## gauge

Use for: One value against a fixed limit, such as storage, quota or capacity.

Avoid for: Values without a natural maximum. Several values; use a bar gauge.

- `value` (number): The current value; the needle stops at the range, the tooltip keeps the real value.
- `min, max` (number): The range of the dial.
- `unit` (string): Unit after the value.
- `format` ({ style?, currency?, unit?, decimals?, compact? }): Number format by name (style "number", "percent" or "currency") with an ISO currency, decimals and compact notation.
- `thresholds` ({ value, label? }[]): Band edges; each band gets its own color.

```json
{"kind":"gauge","title":"Storage used","subtitle":"Of 2 TB · invented data","value":1.46,"min":0,"max":2,"unit":"TB","format":{"decimals":2},"thresholds":[{"value":1.4,"label":"Plan more"},{"value":1.8,"label":"Full soon"}]}
```

## sparkline

Use for: The direction of a value next to the value itself. Many small trends in a list or table.

Avoid for: Exact values or dates; use a line chart with axes. Comparing series with each other.

- `data` (number[]): Values in order; at least two.
- `area` (boolean): Fills the area under the line.

```json
{"kind":"sparkline","title":"Subscribers, last 12 weeks","data":[44120,44380,44210],"area":true}
```

## boxplot

Use for: Comparing the spread of several groups. Showing outliers without hiding the typical range.

Avoid for: Readers who do not know box plots; a histogram or a short sentence may say more. Fewer than about ten values per group.

- `data` ({ label, values: number[] }[]): One group of raw values per box; the quartiles are computed.
- `yAxis` ({ label?, domain?, ticks?, scale?, format? }): Vertical axis: label, exact [min, max], tick count, "log" scale and a number or date format.

```json
{"kind":"boxplot","title":"Delivery time by carrier","subtitle":"Days from order to door · invented data","data":[{"label":"Carrier A","values":[1.2,1.5,1.8]},{"label":"Carrier B","values":[1.9,2.2,2.5]},{"label":"Carrier C","values":[0.9,1,1.1]}],"yAxis":{"label":"Days"}}
```

## heatmap (layout "calendar")

Use for: Daily observations and weekly patterns.

Avoid for: Exact comparisons between close values.

- `layout` ("calendar"): Additive to the existing heatmap kind.
- `data` ([ISO day,number | null][]): Unique valid YYYY-MM-DD days across at most three years; missing and null days are gaps.
- `scale` ("sequential" | "diverging"): Colors use every observation, including scrolled-out weeks.

```json
{"kind":"heatmap","layout":"calendar","title":"Opens per day","scale":"sequential","data":[["2025-01-01",0],["2025-01-02",17],["2025-01-03",34]]}
```

## heatmap

Use for: Patterns across two categories, such as weekday and hour. Spotting the busiest and quietest combinations.

Avoid for: Exact comparison of values; color is read only roughly. More rows than fit the frame; group them first.

- `data` ({ x, y, value }[]): One cell per pair; x names the column, y the row.
- `showValues` (boolean): Prints the value in every cell that fits it.
- `min, max` (number): Fixed ends of the color scale.
- `format` ({ style?, currency?, unit?, decimals?, compact? }): Number format by name (style "number", "percent" or "currency") with an ISO currency, decimals and compact notation.

```json
{"kind":"heatmap","title":"Newsletter opens by day and time","subtitle":"Last 8 weeks · invented data","data":[{"x":"6–9","y":"Mon","value":120},{"x":"9–12","y":"Mon","value":340},{"x":"12–15","y":"Mon","value":260}],"tooltip":{"label":"Opens"}}
```

## barGauge

Use for: Usage of several accounts, rooms or machines against the same limit.

Avoid for: Values without a shared maximum; use a bar chart.

- `data` ({ label, value, min?, max? }[]): One row per item; up to eight rows fit the frame.
- `min, max` (number): The shared range.
- `unit` (string): Unit after each value.
- `format` ({ style?, currency?, unit?, decimals?, compact? }): Number format by name (style "number", "percent" or "currency") with an ISO currency, decimals and compact notation.
- `thresholds` ({ value, label? }[]): Band edges for every row.

```json
{"kind":"barGauge","title":"Mailbox quota","subtitle":"Used of 10 GB · invented data","data":[{"label":"Support","value":8.7},{"label":"Sales","value":6.2},{"label":"Accounting","value":4.9}],"min":0,"max":10,"unit":"GB","thresholds":[{"value":7,"label":"Close"},{"value":9,"label":"Full"}]}
```

## stat

Use for: The one number a reader needs first, with its direction.

Avoid for: Several equal numbers in a row; use key figure tiles. A change without knowing what is better; leave better out.

- `value` (number): The key figure.
- `format` ({ style?, currency?, unit?, decimals?, compact? }): Number format by name (style "number", "percent" or "currency") with an ISO currency, decimals and compact notation.
- `delta` (number): Change against the previous period, in the format of the value.
- `better` ("up" | "down"): Which direction is good; only then the change is colored.
- `sparkline` (number[]): The recent trend behind the number.

```json
{"kind":"stat","title":"Revenue from the newsletter","subtitle":"October against September","value":18420,"format":{"style":"currency","currency":"EUR"},"delta":2460,"better":"up","sparkline":[11200,12900,12100]}
```

## treemap

Use for: Many nonnegative parts of one total, grouped by color.

Avoid for: Negative values or precise comparisons between similar values.

- `groups` (string[]): Group names in palette order.
- `data` ({label,group,value}[]): Nonnegative parts. Labels print only when they fit.
- `legend` (boolean): Group color meanings; true by default.

```json
{"kind":"treemap","title":"Inventory by category","groups":["Furniture","Lights","Art"],"data":[{"label":"Cabinets","group":"Furniture","value":24000},{"label":"Tables","group":"Furniture","value":16000},{"label":"Chairs","group":"Furniture","value":11000}]}
```

## pareto

Use for: Finding the few categories that account for most of a total.

Avoid for: Signed values or a time trend.

- `labels` ([string,string]): Current and previous period names.
- `data` ({label,value,prev,rest?}[]): Nonnegative values; sorted descending, with rest: true categories last.

```json
{"kind":"pareto","title":"Revenue by region","labels":["2026","2025"],"data":[{"label":"North","value":140000,"prev":120000},{"label":"East","value":105000,"prev":97000},{"label":"South","value":86000,"prev":90000}]}
```

## bubble

Use for: Comparing two measures and one nonnegative area measure for named observations. Named scatter points: omit size.

Avoid for: Precise ranking of many similarly sized bubbles.

- `averages` (boolean): Show explicitly labelled unweighted averages.
- `data[].size` (number >= 0): Optional per-point field. Bubble area is proportional to size.

```json
{"kind":"bubble","title":"Campaigns","groups":["North","South"],"xLabel":"Visits","yLabel":"Opens","sizeLabel":"Audience","averages":true,"data":[{"label":"Letter A","group":"North","x":120,"y":80,"size":400},{"label":"Letter B","group":"North","x":240,"y":120,"size":900},{"label":"Letter C","group":"South","x":180,"y":160,"size":600}]}
```

## radar

Use for: Comparing profiles on 3–8 axes with the same unit and maximum.

Avoid for: Combining unrelated units or independently scaled axes.

- `max` (number > 0): One common maximum for every axis.
- `series` (1..4 series): Exactly one bounded value per axis.

```json
{"kind":"radar","title":"Plan scores","axes":["Quality","Speed","Cost"],"max":5,"unit":"points","series":[{"label":"Plan A","data":[4,3,2]},{"label":"Plan B","data":[2,4,4]}]}
```

## sankey

Use for: Converging and diverging flows with a common unit.

Avoid for: Cycles or unrelated measures; use bars for unrelated categories.

- `nodes` ({id,label,tone?}[]): Unique ids; tone colors outgoing flows. Each node shows the larger of incoming and outgoing totals, keeping imbalances visible.
- `links` ({source,target,value}[]): Positive values and existing endpoints; no cycles.
- `legend` ({tone,label}[]): Explicit color meanings; wraps within the plot width.

```json
{"kind":"sankey","title":"Paths after the click","nodes":[{"id":"click","label":"Clicked","tone":"blue"},{"id":"article","label":"Article","tone":"green"},{"id":"offer","label":"Offer","tone":"violet"},{"id":"signup","label":"Signed up","tone":"in"}],"links":[{"source":"click","target":"article","value":520},{"source":"click","target":"offer","value":280},{"source":"article","target":"signup","value":140}]}
```

## balanceFlow

Use for: Reconciled balances across consecutive settlement periods. Showing how receipts, deductions and payouts explain the remaining balance.

Avoid for: Unreconciled or missing balances. Unrelated measures or conversions between currencies.

- `periods` ({label,opening,inflows,outflows,closing}[]): In chronological order. Every equation must balance, and closing must equal the next opening exactly as decimal inputs.
- `currency` (ISO 4217 string): One currency for every amount, formatted without a sign. Negative balances explicitly say owed.
- `locale` (BCP 47 string): Optional override of the inherited UI locale.

```json
{"kind":"balanceFlow","title":"Marketplace settlements","subtitle":"Fictional data · EUR","currency":"EUR","locale":"en-GB","periods":[{"label":"October 2026","opening":1200,"inflows":[{"label":"Marketplace orders","value":8400}],"outflows":[{"label":"Cases","value":120},{"label":"Refunds","value":320},{"label":"Marketplace fees","value":760},{"label":"Shipping labels","value":400},{"label":"Payouts","value":6000}],"closing":2000},{"label":"November 2026","opening":2000,"inflows":[{"label":"Marketplace orders","value":7200}],"outflows":[{"label":"Fees and shipping","value":1200},{"label":"Payouts","value":6500}],"closing":1500},{"label":"December 2026","opening":1500,"inflows":[{"label":"Marketplace orders","value":10300}],"outflows":[{"label":"Fees and shipping","value":1800},{"label":"Payouts","value":7000}],"closing":3000}]}
```
