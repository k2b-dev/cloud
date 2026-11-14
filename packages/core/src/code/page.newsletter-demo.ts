/**
 * A Code page that reproduces the chart showcase's Newsletter dashboard from Code data, with the chart kinds Code has
 * today. The dot matrix, the hatched comparison bars, the funnel and the sankey of the showcase arrive with their
 * chart kinds; until then this page shows the same facts as a line chart, bars, a bar gauge and a table.
 */
export const CODE_NEWSLETTER_DEMO_SOURCE = `import { app, jsx, Page, Stats, Stat, Section, Chart, Table, Column } from "@sdk";

const months = ["2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01",
  "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"];
const opened = [0.441, 0.432, 0.455, 0.462, 0.448, 0.471, 0.466, 0.452, 0.478, 0.481, 0.461, 0.492];
const clicked = [0.172, 0.165, 0.181, 0.188, 0.176, 0.191, 0.186, 0.179, 0.195, 0.199, 0.204, 0.198];
// Invented, repeatable opens per day for 26 weeks: the weekly letter goes out on Thursdays.
const day = (offset: number) => new Date(Date.UTC(2026, 4, 11 + offset)).toISOString().slice(0, 10);
const opens = Array.from({ length: 182 }, (_, index): [string, number] => {
  const weekday = index % 7;
  const base = weekday === 3 ? 5200 : weekday >= 5 ? 900 : 1900;
  return [day(index), Math.round(base * (0.8 + ((index * 37) % 11) / 25))];
});
const campaigns = [
  { name: "Autumn selection", status: "sending", sent: "2026-11-06", recipients: 46900, opened: 0.314, clicked: 0.092, revenue: 2140 },
  { name: "Weekly letter 44", status: "delivered", sent: "2026-10-29", recipients: 46720, opened: 0.492, clicked: 0.198, revenue: 4610 },
  { name: "New in stock", status: "delivered", sent: "2026-10-22", recipients: 46510, opened: 0.526, clicked: 0.221, revenue: 6380 },
  { name: "Trade fair invitation", status: "planned", sent: "2026-11-12", recipients: 47000, opened: null, clicked: null, revenue: null },
  { name: "Weekly letter 43", status: "delivered", sent: "2026-10-15", recipients: 46300, opened: 0.479, clicked: 0.187, revenue: 3950 },
  { name: "Weekly letter 42", status: "delivered", sent: "2026-10-08", recipients: 46080, opened: 0.468, clicked: 0.181, revenue: 3720 },
];
const paths = [
  { from: "Weekly letter 44", to: "Product pages", readers: 2600, bought: 392 },
  { from: "New in stock", to: "Product pages", readers: 2300, bought: 0 },
  { from: "Autumn selection", to: "Trade fair", readers: 1090, bought: 0 },
  { from: "Weekly letter 44", to: "Blog", readers: 1200, bought: 20 },
];

app.get("/", c => c.page(
  <Page eyebrow="Pulse · Website" title="Newsletter" asOf="2026-11-06T09:40:00Z" icon="ti ti-mail" color="blue">
    <Stats>
      <Stat icon="ti ti-users" label="Subscribers" value={48210} delta={{ value: 0.082, better: "up" }}
        compare={{ label: "Last month", value: 44560 }}
        trend={[41200, 41900, 42400, 42100, 42900, 43600, 43300, 44100, 44560, 45900, 47100, 48210]} />
      <Stat icon="ti ti-mail-opened" label="Open rate" value={0.492} format={{ style: "percent", decimals: 1 }}
        delta={{ value: 0.031, unit: "points", better: "up" }} compare={{ label: "Last month", value: 0.461 }} />
      <Stat icon="ti ti-click" label="Click rate" value={0.198} format={{ style: "percent", decimals: 1 }}
        delta={{ value: -0.006, unit: "points", better: "up" }} compare={{ label: "Last month", value: 0.204 }} />
      <Stat icon="ti ti-user-minus" label="Unsubscribes" value={182} delta={{ value: -0.125, better: "down" }}
        compare={{ label: "Last month", value: 208 }} />
    </Stats>
    <Section title="Effect" icon="ti ti-chart-dots-3">
      <Chart.Line width="twoThirds" height="md" title="Opens and clicks per month" subtitle="Share of recipients"
        yAxis={{ format: { style: "percent" } }} series={[
          { label: "Opened", data: months.map((x, i) => ({ x, y: opened[i] ?? 0 })) },
          { label: "Clicked", data: months.map((x, i) => ({ x, y: clicked[i] ?? 0 })) },
        ]} />
      <Chart.Bar width="third" height="md" title="Revenue from the newsletter" subtitle="October, by week"
        yAxis={{ format: { style: "currency", currency: "EUR" } }} data={[
          { label: "1–7", value: 3120 }, { label: "8–14", value: 4380 }, { label: "15–21", value: 3940 },
          { label: "22–28", value: 4610 }, { label: "29–31", value: 2370 },
        ]} />
    </Section>
    <Section title="After the click" icon="ti ti-route">
      <Chart.BarGauge width="third" height="md" title="From sending to buying" subtitle="Weekly letter 44" max={46900} data={[
        { label: "Delivered", value: 46120 }, { label: "Opened", value: 23075 }, { label: "Clicked", value: 9290 }, { label: "Bought", value: 412 },
      ]} />
      <Table width="twoThirds" title="Paths after the click" subtitle="October · campaign, page, result" rows={paths}>
        <Column key="from" label="Campaign" />
        <Column key="to" label="Page" />
        <Column key="readers" label="Readers" type="number" />
        <Column key="bought" label="Bought" type="number" priority={2} />
      </Table>
    </Section>
    <Section title="Campaigns" icon="ti ti-send">
      <Table title="Campaigns" subtitle="Latest 6 of 38 · sortable" rows={campaigns} search empty="No campaign in this period.">
        <Column key="name" label="Campaign" />
        <Column key="status" label="Status" type="status" states={{
          sending: { label: "Sending", tone: "running" }, delivered: { label: "Delivered", tone: "ok" }, planned: { label: "Planned", tone: "neutral" },
        }} />
        <Column key="sent" label="Sent" type="date" priority={3} />
        <Column key="recipients" label="Recipients" type="number" priority={2} />
        <Column key="opened" label="Opened" type="number" format={{ style: "percent", decimals: 1 }} />
        <Column key="clicked" label="Clicked" type="number" format={{ style: "percent", decimals: 1 }} priority={2} />
        <Column key="revenue" label="Revenue" type="amount" format={{ style: "currency", currency: "EUR" }} />
      </Table>
    </Section>
    <Section title="Audience" icon="ti ti-users-group">
      <Chart.Heatmap width="twoThirds" height="sm" layout="calendar" scale="sequential" title="Opens per day"
        subtitle="Last 26 weeks · the weekly letter goes out on Thursdays" data={opens} />
      <Chart.Bar width="third" height="sm" title="Opens by country" subtitle="October" data={[
        { label: "Germany", value: 14120 }, { label: "Austria", value: 3240 }, { label: "Switzerland", value: 2540 },
        { label: "Netherlands", value: 1150 }, { label: "France", value: 690 },
      ]} />
    </Section>
  </Page>
));
export default app;
`;
