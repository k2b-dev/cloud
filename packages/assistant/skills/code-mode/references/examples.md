# Complete examples

## Headless calculation

```js
export default () => ({ answer: 42 });
```

## Inspect a supplied CSV and produce a copy

Run with `code_run({ code, inputPaths: ["/sales.csv"] })`:

```js
export default async (_input, { files }) => {
  if (!files.length) throw new Error("Supply a CSV file first.");
  const rows = await cloud.sheet.parseCsv(await files[0].file());
  await cloud.download("export.csv", await cloud.sheet.toCsv(rows));
  return { rows: rows.length, columns: Object.keys(rows[0] ?? {}) };
};
```

## Dashboard from a CSV file

The person uploads a bank export or sales CSV; the app sums it by category,
keeps the last file in `cloud.files`, and reads it again on the next start.
Copy a CSV the user gave you into the app with `code_file_copy`, so the app
starts with it.

`index.html`:

```html
<main>
  <header class="row"><h1>Spending</h1></header>
  <label>CSV file <input id="file" type="file" accept=".csv,text/csv"></label>
  <p id="error" role="alert"></p>
  <div class="grid"><div class="stat"><span>Total</span><strong id="total">–</strong></div></div>
  <figure id="chart"></figure>
  <details><summary>Values</summary><figure><table><thead><tr><th>Category</th><th class="num">Amount</th></tr></thead><tbody id="rows"></tbody></table></figure></details>
</main>
```

`app.js`:

```js
const [input, error, total, chart, rows] = ["#file", "#error", "#total", "#chart", "#rows"].map((selector) => document.querySelector(selector));
const euro = new Intl.NumberFormat(cloud.locale, { style: "currency", currency: "EUR" });

async function show(file) {
  error.textContent = "";
  try {
    const sums = new Map();
    for (const row of await cloud.sheet.parseCsv(file))
      if (typeof row.Amount === "number") sums.set(row.Category, (sums.get(row.Category) ?? 0) + row.Amount);
    const data = [...sums].map(([label, value]) => ({ label, value }));
    total.textContent = euro.format(data.reduce((sum, item) => sum + item.value, 0));
    chart.innerHTML = cloud.chart({ kind: "bar", title: "Spending by category", data, yAxis: { format: (v) => euro.format(v) } });
    rows.innerHTML = cloud.html`${data.map((item) => cloud.html`<tr><td>${item.label}</td><td class="num">${euro.format(item.value)}</td></tr>`)}`;
  } catch (failure) {
    error.textContent = failure.message;
  }
}
input.addEventListener("change", async () => {
  const [file] = input.files;
  if (!file) return;
  await cloud.files.write("last.csv", file);
  await show(file);
});
const saved = await cloud.files.read("last.csv");
if (saved) await show(saved);
```

Before writing such an app around a real file, run a script over the file and
compare its totals with an independent sum.

## Form to PDF

`index.html` has a form with `customer` and `amount` fields and a
`<p id="status" role="status">` after it.

```js
const form = document.querySelector("form");
const status = document.querySelector("#status");
form.addEventListener("submit", async () => {
  const button = form.querySelector("button");
  const { customer, amount } = Object.fromEntries(new FormData(form));
  const price = cloud.money.format(cloud.money.fromDecimal(amount, { currency: "EUR" }));
  button.disabled = true;
  button.ariaBusy = "true";
  try {
    const pdf = await cloud.pdf.render({ title: "Quote", html: cloud.html`<h1>Quote</h1><p>For ${customer}: ${price}</p>` });
    await cloud.download("Quote.pdf", pdf);
    status.textContent = "Quote created.";
  } catch (failure) {
    status.textContent = failure.message;
  } finally {
    button.disabled = false;
    button.ariaBusy = "false";
  }
});
```

## Reusable procedures beyond an interface

- **Stateless converter:** publish a `convert` action taking explicit CSV text,
  save a JSON output with `cloud.download`, then let the agent export it. No database
  is needed. A one-time conversion remains a chat-scoped script.
- **Agent-only importer:** publish an `importItems` action with stable business
  keys. Initialize schema with Manage before sharing; Use-level callers reuse
  the same App data across chats. Unique keys prevent silent duplicate records.
- **Display-only dashboard:** the interface reads results; separate published actions
  maintain them. Do not add configuration controls just to let the agent work.
- **Invoice matcher:** inspect a spreadsheet and selected invoice pages, ask for
  ambiguous matches, copy exactly the chosen file through [File transfers](files.md),
  then call a published linking action. A linked Skill can describe this workflow;
  its access remains separate from the App's.

Read [App actions](app-actions.md) for the complete publication/call contract.
The canonical Assistant documentation links runnable source bundles for these
four flows. Do not infer additional database methods from these use cases.
