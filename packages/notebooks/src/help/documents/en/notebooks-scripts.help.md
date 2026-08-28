---
id: notebooks-scripts
title: "Scripts"
icon: "ti ti-code"
description: "Build dashboards, buttons, charts, and small workflows from notebook data."
order: 150
---

Scripts are trusted JavaScript blocks for small notebook apps. Use them when named blocks, tags, notes, or attachments should become interactive output.

:::warning Scripts are trusted code
Script blocks run in the browser of users who open the note. They can use browser APIs, read notebook content visible to that user, and perform notebook actions with that user's permissions.
:::

**Script workflow**

## Build in this order {icon="list-check"}

:::steps
1. **Read:** Read named blocks, tags, notes, attachments, or state through the public API.
2. **Render:** Render the smallest useful output first: metric, table, chart, note list, or Markdown.
3. **Act:** Add buttons and prompts after the read path is clear.
4. **Keep context:** Leave names, headings, and descriptions in the note so people and agents can understand why the script exists.
:::

**Small script structure**

```javascript
// 1. Read source data
const ideas = current.table("ideas")?.rows ?? [];

// 2. Render output
ui.render(
  ui.metric("Ideas", ideas.length, { icon: "ti ti-bulb" }),
  ui.live(() => ui.table(current.table("ideas")?.rows ?? [])),
);

// 3. Add actions when needed
ui.button("Add idea", async () => {
  const title = await ui.prompt.text("Idea title");
  if (title) await current.table("ideas")?.add(title, "new");
}).show();
```

**Examples**

## Useful patterns {icon="code"}

**Live dashboard from note data**

````text
```script
ui.live(() => {
  const plants = current.table("plants")?.rows ?? [];
  const tasks = current.todo("tasks")?.items ?? [];
  const open = tasks.filter((task) => !task.done);

  return ui.row(
    ui.metric("Plants", plants.length, { icon: "ti ti-plant-2", tone: "success" }),
    ui.metric("Open tasks", open.length, { icon: "ti ti-checkbox", tone: "warning" }),
  );
}).show();
```
````

**Button workflow**

```javascript
ui.render(
  ui.live(() => ui.table(current.table("ideas")?.rows ?? [], { emptyText: "No ideas yet." })),
  ui.button("Add idea", async () => {
    const title = await ui.prompt.text("Idea title", "", { title: "New idea" });
    if (!title) return;

    const note = await nb.create({ content: "# " + title + "\n\n#idea" });
    await current.table("ideas")?.add(title, note, ["#idea"], "new");
    ui.toast("Idea added", { variant: "success" });
  }),
);
```

**Chart from a table**

```javascript
const harvest = current.table("harvest")?.rows ?? [];

ui.chart("bar", {
  height: 220,
  showValues: true,
  data: harvest.map((row) => ({
    label: row.Plant,
    value: Number(row.Grams ?? 0),
  })),
}).show();
```

**Search notes and render a table**

```javascript
const notes = await nb.search("#garden");

ui.table(notes.map((note) => ({
  note,
  tags: note.tags,
  openTasks: note.todos().flatMap((list) => list.items).filter((todo) => !todo.done).length,
  updated: note.updatedAt,
}))).show();
```

**Full form example**

```javascript
const values = await ui.prompt.form({
  title: "Add plant",
  submitText: "Add",
  fields: {
    name: { type: "text", label: "Plant name", required: true, placeholder: "Tomato" },
    notes: { type: "textarea", label: "Notes", rows: 3 },
    count: { type: "number", label: "Seedlings", min: 0, default: 1 },
    perennial: { type: "boolean", label: "Perennial", default: false },
    status: { type: "select", label: "Status", options: ["planned", "sown", "planted"], default: "planned" },
  },
});

if (!values) return;
await current.table("plants")?.add(values.name, values.status, values.count, values.notes);
ui.toast("Plant added", { variant: "success" });
```

**Shared current.kv state**

```javascript
const slot = ui.col();
slot.show();

const render = () => {
  const value = current.kv.get("counter") ?? 0;
  slot.replaceChildren(
    ui.row(
      ui.text("Shared counter: " + value),
      ui.button("+1", () => current.kv.set("counter", (current = 0) => current + 1)),
      ui.button("Reset", () => current.kv.delete("counter")),
    ),
  );
};

render();
current.kv.observe("counter", render);
```

**Upload and insert attachments**

```javascript
const files = await nb.attachments.uploadFromPicker({ accept: "image/*", multiple: true });

for (const file of files) {
  await nb.attachments.insertIntoContent(file.id);
}

ui.toast(files.length + " file(s) inserted", { variant: "success" });
```
