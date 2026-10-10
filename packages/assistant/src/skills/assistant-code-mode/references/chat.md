# Chat apps

Just data → `chart` tool; interaction → chat app (`code_present`); persistence
or reuse → saved Studio App. A chart of numbers you already have needs no app:
pass `cloud.chart()` options as plain data to the `chart` tool, and Cloud draws
it in the chat with a data table.

Use `code_present` to show an HTML app as a card in this chat when the person
works with it: a calculator, a chart with filters, a small dashboard or report
that belongs to this answer. The card has a fixed height and starts on a click;
it never runs while someone scrolls past it. Read [HTML apps](apps.md) for the
files, styles and sandbox rules.

- **One-off:** `code_present({ title, files: [{ path: "index.html", content }, …] })`.
  The files are stored with the chat. A one-off app has no database, `cloud.kv`
  or `cloud.files`; those calls reject with `unavailable`. Put the data it shows
  into the files, for example as `export const rows = [...]` in `data.js`.
- **Saved app:** `code_present({ id })` shows an existing app with its data and
  current source, under its title unless you pass one. The card offers Open to
  show it beside the chat.

```js
// code_present files: index.html
// <main><h1>Quarter</h1><label>Region <select id="region"></select></label><figure id="chart"></figure></main>
// app.js
import { months, regions } from "./data.js";
const select = document.querySelector("#region");
select.innerHTML = cloud.html`${regions.map((region) => cloud.html`<option>${region}</option>`)}`;
const draw = () => {
  document.querySelector("#chart").innerHTML = cloud.chart({
    kind: "bar",
    title: `Revenue per month, ${select.value}`,
    data: months.map((month) => ({ label: month.label, value: month.revenue[select.value] })),
  });
};
select.addEventListener("change", draw);
draw();
```

Compute the numbers first: run a script with `code_run` over the chat files,
check the totals, and write the result into `data.js`. Never retype truncated
tool output into a data file; export it with `cloud.download` and `code_export`
and read the exported file.

Before showing an app, run `code_check` on exactly the files you will present,
including `steps.json` (see [HTML apps](apps.md)). `code_present` refuses an app
without a passing check for those files, or for a saved app's current files and
tables. It also refuses static errors such as CDN scripts, missing imports, inline
handlers or network URLs; warnings come back with the result. A passing check
does not judge design or business logic, so mention what the person can do with
the app.

The card's download menu saves a static copy of the app as it is shown, as HTML
or PDF. The copy runs no scripts. A download does not create a chat file; to
hand a file to the agent or another tool, create it with `cloud.download` in a
script and `code_export` it.

Each presentation is immutable and stays with its chat; a corrected app is a new
`code_present` call. Presentations of a chat share a 250 MiB budget. Cloud
capabilities and HTTP calls from a card keep their normal permission checks and
ask the person each time.
