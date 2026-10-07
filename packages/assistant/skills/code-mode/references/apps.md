# HTML apps

A Studio **app** is plain HTML, CSS and JavaScript: `index.html`, plus optional
`style.css` and `app.js`. `app.js` is an ES module: top-level `await` works, and
so do relative imports of other app JavaScript files
(`import { total } from "./sum.js"`). No frameworks, TypeScript, build steps,
CDNs, npm packages or JSON/CSV imports. Cloud adds the document head and loads
`style.css` and `app.js` automatically; an inline `<script>` runs as a module too.

## It looks like Cloud by default

A base stylesheet styles plain semantic HTML in light and dark: headings, lists,
tables, forms, buttons, `<details>`, `<dialog>`, `<progress>`. Write little CSS;
your rules always win. Cloud is flat: no borders, cards or shadows around
sections; separate them with headings and whitespace, and avoid fixed pixel
widths. For colors use tokens such as `var(--k2b-action)` or
`var(--k2b-text-muted)`, never fixed colors or `prefers-color-scheme`.

Patterns that need no CSS:

- Checklist: `<li><label><input type="checkbox"> Title</label><button type="button" class="danger">Delete</button></li>`.
- Header with an action: `<header class="row"><h1>Expenses</h1><button type="button" class="primary">Export</button></header>`.
- Fields side by side: `<form class="row"><label>Name <input name="name"></label><button>Add</button></form>`; a field grid: `<div class="grid"><label>…</label><label>…</label></div>`.
- Key figures: `<div class="grid"><div class="stat"><span>Revenue</span><strong>12.400 €</strong></div></div>` (flat, no surface).
- Status: `<span class="tag" data-tone="success">Paid</span>` (tones: info, success, warning, danger).
- Feedback: `<p role="alert">` for errors (hidden while empty), `<p role="status">` for quiet notes.
- Tabs or filters: buttons in a `<nav>` with `aria-pressed="true"` on the active one.
- Wide tables: wrap them in `<figure>`; they scroll sideways on phones. Details: `<dl>`.
- Classes: `row`, `grid`, `stat`, `scroll`, `tag`, `muted`, `num` (right-aligned numbers), `primary`, `danger`, `sr-only`.

Custom flex or grid layouts set `gap` and `> * { margin: 0 }`; otherwise gap and
the flow spacing add up. On phones, put secondary values in a `<small>` under the
main cell instead of adding columns.

## Platform API

The same frozen `cloud` as in scripts; read [cloud contract](cloud.md). Await
every call; `cloud.money.*`, `cloud.chart()` and `cloud.html` are synchronous.

- Where data lives: per person (my todos, my settings) → `cloud.kv.user`; small
  app-wide settings → `cloud.kv`; records several people add or edit →
  `cloud.db`, one row each. Tables are created while building with
  `code_database`, never in app code. `cloud.files` holds app files.
- `cloud.user` is `{ id, name }` of the viewer. Rows carry `created_by` and
  `updated_by` automatically.
- Render with `cloud.html`; it escapes every value, so never build markup by
  string concatenation. Quote attribute values; `${done ? "checked" : ""}`
  works for boolean attributes.
- Output: `cloud.download(name, blob)`, `cloud.pdf.render({ html })` (PDFs get
  the same base stylesheet), `element.innerHTML = cloud.chart({ kind: "bar", data })`.
- Use `cloud.locale` with `Intl`. A failed call rejects with `error.code`; show
  `error.message` in the page.

## Sandbox rules

- No network, no `fetch`, no `localStorage`; use `cloud.*`. `cloud.http.fetch`
  asks the person for every request.
- `alert`, `confirm`, `prompt` and `document.write` throw; ask with a `<dialog>` (below).
- Cloud removes every `<link>` element, also ones added from JavaScript. Put CSS
  into `style.css`.
- Inline handlers (`onclick="…"`, also inside generated markup) never run. Use
  `addEventListener`; for lists, one listener on the list:
  `list.addEventListener("click", (e) => { const row = e.target.closest("[data-id]"); … })`.
- Every `<button>` that does not submit its form needs `type="button"`.
- Forms never navigate; handle `submit`. Prefer native controls: checkbox,
  `select`, `<input type="file">`, `<details>`, `<dialog>`.
- Links open in a new tab only after the person confirms; `location.hash` is the
  place for view state such as the active tab, and it survives a reload.
- Whenever Cloud asks the person something for the app (an HTTP request, a
  capability, a link), the app is greyed out and cannot be used until they answer.

## Confirm before deleting

```html
<dialog id="confirm">
  <form method="dialog">
    <p id="confirm-text"></p>
    <footer><button value="cancel">Cancel</button><button value="ok" class="danger">Delete</button></footer>
  </form>
</dialog>
```

```js
function ask(text) {
  const dialog = document.querySelector("#confirm");
  dialog.querySelector("#confirm-text").textContent = text;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true }));
}
```

## Example: personal todo list

`index.html`:

```html
<main>
  <h1>Tasks</h1>
  <form class="row">
    <label class="sr-only" for="title">New task</label>
    <input id="title" name="title" placeholder="New task" autocomplete="off" required>
    <button>Add</button>
  </form>
  <ul id="list"></ul>
  <p id="count" class="muted"></p>
</main>
```

`app.js`:

```js
const form = document.querySelector("form");
const list = document.querySelector("#list");
const count = document.querySelector("#count");
let todos = (await cloud.kv.user.get("todos")) ?? [];

const render = () => {
  list.innerHTML = cloud.html`${todos.map((todo) => cloud.html`<li data-id="${todo.id}">
    <label><input type="checkbox" ${todo.done ? "checked" : ""}> ${todo.title}</label>
    <button type="button" class="danger" aria-label="Delete ${todo.title}">Delete</button></li>`)}`;
  count.textContent = `${todos.filter((todo) => !todo.done).length} open`;
};
const save = () => cloud.kv.user.set("todos", todos);

form.addEventListener("submit", async () => {
  const title = form.elements.title.value.trim();
  if (!title) return;
  todos.push({ id: crypto.randomUUID(), title, done: false });
  form.reset();
  render();
  await save();
});
// Toggling does not re-render, so keyboard focus stays on the checkbox.
list.addEventListener("change", async (event) => {
  todos.find((todo) => todo.id === event.target.closest("li").dataset.id).done = event.target.checked;
  count.textContent = `${todos.filter((todo) => !todo.done).length} open`;
  await save();
});
list.addEventListener("click", async (event) => {
  if (!event.target.closest("button")) return;
  todos = todos.filter((todo) => todo.id !== event.target.closest("li").dataset.id);
  render();
  await save();
});
render();
```

More complete apps, a CSV dashboard and a form that creates a PDF, are in
[Examples](examples.md).

## Show, save and check an app

- A reusable app: `code_create`, then write `index.html`, `style.css` and
  `app.js` with `code_write`, and show it beside the chat with `code_open` or
  in the chat with `code_present({id})`.
- A one-off view for this answer: `code_present({title, files})` with the files
  directly; it needs no saved app and has no saved data. See
  [Chat apps](chat.md).
- `code_write` and `code_present` report static problems: CDN or npm imports,
  missing app files, inline handlers, `alert`, `localStorage`, native `fetch`,
  links to the network. `code_present` refuses errors and returns warnings.
- Apps are not run by `code_run`; there is no automatic rendered test yet. Test
  calculations and data handling in a script with `code_run` before you put them
  into the app, keep the app logic small, and say that the person should look at
  the app when you deliver it.
- Studio's app page and the full-screen runner start an app on their own for
  people who manage it. Everyone else, a tab opened beside the chat, and every
  chat card wait for a click on Start. Errors and `console` output of a running
  app appear in its Studio console; a chat card only says that the app failed
  while starting.
