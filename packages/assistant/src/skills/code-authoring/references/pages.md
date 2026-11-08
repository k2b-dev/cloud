# Pages and building blocks

A Code page is a route that returns `c.page(<Page>…</Page>)`. Write it in a
`.tsx` file and import `jsx` and the blocks from `@sdk`. Cloud checks the tree
and draws every block with its shared components, on the server and in the
browser, in light and dark and at phone width. There is no HTML, CSS, SVG,
script, event handler or foreign link. `c.html()` does not exist.

Core hosts the active version at `/code/<code-id>/…`. Routes need a signed-in
person unless they declare `{ public: true }` ([Access](access.md)).

## The smallest page

<!-- check: personal -->
```tsx
import { app, jsx, Page, Heading, Text } from "@sdk";

app.get("/", c => c.page(
  <Page title="Reading list" subtitle="Updated each Monday" icon="ti ti-books" color="blue">
    <Heading level={2}>This week</Heading>
    <Text>Nothing is due.</Text>
  </Page>
));
export default app;
```

## Blocks

Data, such as `rows` or chart `data`, is a prop. The parts of a block are its
children. A wrong prop or value is a type error in `code_check`; a part in the
wrong block fails with `code_page_child`.

| Block | Props | Children |
| --- | --- | --- |
| `Page` | `title`, optional `subtitle`, `icon`, `color`, `follow` | blocks; the root of every page |
| `Section` | `title`, optional `description`, `icon`, `color` | blocks |
| `Stats` | none | 1–6 `Stat` |
| `Stat` | `label`, `value` (number, text or `null`), optional `format`, `delta`, `compare`, `trend` | none |
| `Text`, `Heading` | `Heading` has optional `level: 2 \| 3 \| 4` | text |
| `Table` | `title`, `rows` of scalar values, optional `empty`, `width` | 1–20 `Column` |
| `Column` | `key` (the row field), `label`, optional number `format` | none |
| `Detail` | `title`, optional `width` | `Item` |
| `Item` | `label`, `value` | none |
| `Form` | `title`, `action`, `submit`, optional `width`; always POST | 1–40 `Field.*` |
| `Field.Text`, `Field.Email`, `Field.Textarea`, `Field.Scan` | `name`, `label`, optional text `value`, `required`, `error` | none |
| `Field.Number` | as above with a number `value` | none |
| `Field.Checkbox` | as above with a boolean `value` | none |
| `Field.Select` | as above with a text `value` | `Option` (`value`, `label`) |
| `Chart.Bar`, `Chart.Line`, `Chart.Scatter`, `Chart.Pie`, `Chart.Donut`, `Chart.Histogram`, `Chart.Gauge`, `Chart.Sparkline`, `Chart.Boxplot`, `Chart.Heatmap`, `Chart.BarGauge`, `Chart.Stat` | the chart's own props, such as `title`, `data`, `series`; optional `width` | none |
| `Chart.Empty` | `title`, `empty`, optional `width` | none |
| `Link` | `label`, `href` inside this Code | none |
| `Button`, `Action` | `label`, `action`, optional text `values`; always POST | none |
| `Notice` | `title`, optional `text`, `tone: info \| success \| warning \| danger` | none |

`icon` is a Tabler class such as `ti ti-package`. `color` is `zinc`, `blue`,
`emerald`, `amber` or `red`. A `format` is `{ style?: "number" | "percent" |
"currency", currency?, unit?, decimals?, compact? }`. A `Stat` `delta` is a
share (`0.08` is 8 %, or percentage points with `unit: "points"`) with
`better: "up" | "down"`; `trend` holds up to 60 numbers.

There is no `Chart.Area`, no image block and no free layout. Say so instead
of working around it.

## Lay out a page

Order a page like a Cloud dashboard: key figures first, then sections. Charts,
`Table`, `Detail` and `Form` are framed panels on a six-column grid; `width`
is `third`, `half`, `twoThirds` or `full` (default). Panels in one row share
its height. Up to 1,000 px a third takes half a row; up to 600 px every panel
takes the row. Other blocks always take the whole row. Neighbouring `Button`
and `Action` blocks share one row.

<!-- check: personal -->
```tsx
import { app, jsx, Page, Section, Stats, Stat, Chart } from "@sdk";

const weeks = ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"];
const done = [12, 15, 9, 17];

app.get("/", c => c.page(
  <Page title="Team work" icon="ti ti-chart-bar" color="emerald">
    <Stats>
      <Stat label="Done this week" value={17} delta={{ value: 0.89, better: "up" }} compare={{ label: "Last week", value: 9 }} trend={done} />
      <Stat label="Open" value={42} />
      <Stat label="Budget used" value={0.62} format={{ style: "percent" }} />
    </Stats>
    <Section title="Progress" icon="ti ti-trending-up" color="emerald">
      <Chart.Line width="twoThirds" title="Done per week" series={[{ label: "Done", data: weeks.map((week, i) => ({ x: week, y: done[i] ?? 0 })) }]} />
      <Chart.Donut width="third" title="By priority" data={[{ label: "High", value: 5 }, { label: "Normal", value: 30 }, { label: "Low", value: 7 }]} />
      <Chart.Empty width="half" title="Blocked tasks" empty="Nothing is blocked." />
      <Chart.Gauge width="half" title="Sprint" value={68} min={0} max={100} unit="%" />
    </Section>
  </Page>
));
export default app;
```

On `Chart.Line` and `Chart.Scatter`, every `x` is a number or an ISO date
(`2026-10-05`, optionally with a local time such as `2026-10-05T14:30`, no offset); names such as `"W40"` fail when the
page is drawn. Use `Chart.Bar` for named categories. A chart needs at least one value. When there is nothing to draw, return
`Chart.Empty` with the same title, so the panel keeps its place and says why.
Chart budgets: eight series, 200 values per series and 1,600 marks.

## Build a page from live data

Read data inside the handler, on each request. Shape it in plain TypeScript,
then pass it as props. This mailbox page counts open conversations:

<!-- check: resource mail.mailbox -->
```tsx
import { app, jsx, owner, Page, Stats, Stat, Chart, Table, Column } from "@sdk";

app.get("/", async c => {
  const open = await owner.conversation.list({ view: "needs_action", limit: 50 });
  const waiting = await owner.conversation.list({ view: "waiting", limit: 50 });
  const rows = open.map(item => ({ title: item.title, from: item.participants, messages: item.messageCount }));
  return c.page(
    <Page title="Inbox" subtitle="Needs action and waiting" icon="ti ti-mail" color="blue" follow={["mail.message.received"]}>
      <Stats>
        <Stat label="Needs action" value={open.length} />
        <Stat label="Waiting" value={waiting.length} />
      </Stats>
      {open.length + waiting.length > 0
        ? <Chart.Bar width="third" title="Open work" data={[{ label: "Needs action", value: open.length }, { label: "Waiting", value: waiting.length }]} />
        : <Chart.Empty width="third" title="Open work" empty="No open conversations." />}
      <Table width="twoThirds" title="Needs action" rows={rows} empty="Nothing needs action.">
        <Column key="title" label="Subject" />
        <Column key="from" label="People" />
        <Column key="messages" label="Messages" />
      </Table>
    </Page>
  );
});
export default app;
```

A list query returns at most its `limit`; say "50 or more" instead of
presenting a capped count as exact. `follow` lists up to eight event types;
Cloud loads the page again for its viewer after those events. Until the event
service delivers to open pages, a following page reloads when its tab becomes
visible again.

## Forms

A `Form` POSTs its fields to an own route. Cloud adds and removes the CSRF
token; `_csrf` is a reserved field name. The handler answers with:

- `c.page(...)`: replaces the page in place. To report invalid input, return
  the form again with the submitted values and an `error` on each wrong field.
- `c.redirect(path)`: opens that page of this Code; Back returns.
- `c.json` or `c.text`: counts as done; Cloud loads the current page again.

<!-- check: personal -->
```tsx
import { app, jsx, Page, Form, Field, Option, Detail, Item } from "@sdk";

type Quote = { hours: string; rate: string; kind: string };

const form = (values: Quote, errors: Partial<Record<keyof Quote, string>> = {}) => (
  <Form title="Quote" action="/quote" submit="Calculate">
    <Field.Number name="hours" label="Hours" value={Number(values.hours) || undefined} error={errors.hours} required />
    <Field.Number name="rate" label="Rate per hour (EUR)" value={Number(values.rate) || undefined} error={errors.rate} required />
    <Field.Select name="kind" label="Kind" value={values.kind}>
      <Option value="repair" label="Repair" />
      <Option value="service" label="Service" />
    </Field.Select>
  </Form>
);

app.get("/", c => c.page(<Page title="Quote">{form({ hours: "", rate: "", kind: "repair" })}</Page>));
app.post("/quote", async c => {
  const data = await c.req.formData();
  const values = { hours: String(data.get("hours") ?? ""), rate: String(data.get("rate") ?? ""), kind: String(data.get("kind") ?? "repair") };
  const hours = Number(values.hours);
  const rate = Number(values.rate);
  const errors: Partial<Record<keyof Quote, string>> = {};
  if (!(hours > 0 && hours <= 1000)) errors.hours = "Enter between 0 and 1,000 hours.";
  if (!(rate > 0)) errors.rate = "Enter a rate above 0.";
  if (errors.hours || errors.rate) return c.page(<Page title="Quote">{form(values, errors)}</Page>);
  return c.page(
    <Page title="Quote">
      {form(values)}
      <Detail title="Result">
        <Item label="Kind" value={values.kind === "service" ? "Service" : "Repair"} />
        <Item label="Total (EUR)" value={Math.round(hours * rate * 100) / 100} />
      </Detail>
    </Page>
  );
});
export default app;
```

Submitted values are strings; parse and validate every field on the server.
A failed form keeps its input and names the problem beside its button. When
the answer is lost, the page says that the step may have run; Cloud never
repeats a POST. Make POST handlers safe to repeat: use idempotency keys
derived from the input for Actions. Requests have 8 seconds including queueing,
bodies up to 8 KiB (4 KiB for public routes), responses up to 128 KiB.

`Field.Scan` is a text field with a **Scan** button that opens the device
camera for QR codes; the read text goes into the field.

## Routes, details, buttons and notices

Paths have literal segments and `:name` parameters, read with
`c.req.param(name)`; query strings with `c.req.query(name)`. `Link` and
`Button` targets stay inside this Code. `Button` and `Action` POST their
`values` as form fields.

<!-- check: personal -->
```tsx
import { app, jsx, Page, Detail, Item, Button, Link, Notice } from "@sdk";

const orders: Record<string, { customer: string; total: number; paid: boolean }> = {
  A100: { customer: "Example Ltd", total: 240, paid: false },
};

app.get("/orders/:id", c => {
  const id = c.req.param("id");
  const order = orders[id];
  if (!order) return c.page(<Page title="Order"><Notice tone="warning" title="Order not found" text={`There is no order ${id}.`} /></Page>);
  return c.page(
    <Page title={`Order ${id}`}>
      {c.req.query("saved") === "1" ? <Notice tone="success" title="Saved" /> : null}
      <Detail title="Order">
        <Item label="Customer" value={order.customer} />
        <Item label="Total (EUR)" value={order.total} />
        <Item label="Paid" value={order.paid} />
      </Detail>
      <Button label="Mark as paid" action={`/orders/${id}/paid`} values={{ confirm: "yes" }} />
      <Link label="All orders" href="/" />
    </Page>
  );
});
app.post("/orders/:id/paid", c => c.redirect(`/orders/${c.req.param("id")}?saved=1`));
app.get("/", c => c.page(<Page title="Orders"><Link label="Order A100" href="/orders/A100" /></Page>));
export default app;
```

## Limits and what fails

A page is at most 64 KiB, 256 blocks and 12 levels deep. A table has at most
200 rows and 20 columns, a form 40 fields. Field names are unique. Parts may
come from data (`{tags.map(tag => <Option value={tag} label={tag} />)}`); a
part kept in a variable outside its block fails when the route builds the page.
Only trees built from blocks reach `c.page`; a hand-written object is a type error.

<!-- check: personal fails code_page_child -->
```tsx
import { app, jsx, Page, Table, Column, Item } from "@sdk";

app.get("/", c => c.page(
  <Page title="Wrong">
    <Table title="Rows" rows={[{ a: 1 }]}>
      <Column key="a" label="A" />
      <Item label="Not here" value="x" />
    </Table>
  </Page>
));
export default app;
```
