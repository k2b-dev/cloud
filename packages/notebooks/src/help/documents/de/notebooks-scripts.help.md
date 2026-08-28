---
id: notebooks-scripts
title: "Skripte"
icon: "ti ti-code"
description: "Dashboards, Schaltflächen, Diagramme und kleine Abläufe aus Notizbuchdaten erstellen."
order: 150
---

Skripte sind vertrauenswürdige JavaScript-Blöcke für kleine Notizbuch-Anwendungen. Verwende sie, um aus benannten Blöcken, Tags, Notizen oder Anhängen interaktive Ausgaben zu erstellen.

:::warning Skripte sind vertrauenswürdiger Code
Skriptblöcke laufen im Browser der Personen, die die Notiz öffnen. Sie können Browser-APIs verwenden, Notizbuchinhalte lesen, die für die jeweilige Person sichtbar sind, und Notizbuchaktionen mit deren Berechtigungen ausführen.
:::

**Arbeitsablauf für Skripte**

## In dieser Reihenfolge vorgehen {icon="list-check"}

:::steps
1. **Lesen:** Benannte Blöcke, Tags, Notizen, Anhänge oder Zustand über die öffentliche API lesen.
2. **Darstellen:** Zuerst die kleinste nützliche Ausgabe darstellen: eine Kennzahl, Tabelle, ein Diagramm, eine Notizliste oder Markdown.
3. **Handeln:** Schaltflächen und Eingabeaufforderungen ergänzen, nachdem der Leseweg feststeht.
4. **Kontext erhalten:** Namen, Überschriften und Beschreibungen in der Notiz belassen, damit Personen und Agents verstehen, warum das Skript vorhanden ist.
:::

**Aufbau eines kleinen Skripts**

```javascript
// 1. Quelldaten lesen
const ideas = current.table("ideas")?.rows ?? [];

// 2. Ausgabe darstellen
ui.render(
  ui.metric("Ideen", ideas.length, { icon: "ti ti-bulb" }),
  ui.live(() => ui.table(current.table("ideas")?.rows ?? [])),
);

// 3. Bei Bedarf Aktionen ergänzen
ui.button("Idee hinzufügen", async () => {
  const title = await ui.prompt.text("Titel der Idee");
  if (title) await current.table("ideas")?.add(title, "new");
}).show();
```

**Beispiele**

## Nützliche Muster {icon="code"}

**Live-Dashboard aus Notizdaten**

````text
```script
ui.live(() => {
  const plants = current.table("plants")?.rows ?? [];
  const tasks = current.todo("tasks")?.items ?? [];
  const open = tasks.filter((task) => !task.done);

  return ui.row(
    ui.metric("Pflanzen", plants.length, { icon: "ti ti-plant-2", tone: "success" }),
    ui.metric("Offene Aufgaben", open.length, { icon: "ti ti-checkbox", tone: "warning" }),
  );
}).show();
```
````

**Ablauf mit Schaltfläche**

```javascript
ui.render(
  ui.live(() => ui.table(current.table("ideas")?.rows ?? [], { emptyText: "Noch keine Ideen." })),
  ui.button("Idee hinzufügen", async () => {
    const title = await ui.prompt.text("Titel der Idee", "", { title: "Neue Idee" });
    if (!title) return;

    const note = await nb.create({ content: "# " + title + "\n\n#idea" });
    await current.table("ideas")?.add(title, note, ["#idea"], "new");
    ui.toast("Idee hinzugefügt", { variant: "success" });
  }),
);
```

**Diagramm aus einer Tabelle**

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

**Notizen suchen und als Tabelle darstellen**

```javascript
const notes = await nb.search("#garden");

ui.table(notes.map((note) => ({
  note,
  tags: note.tags,
  openTasks: note.todos().flatMap((list) => list.items).filter((todo) => !todo.done).length,
  updated: note.updatedAt,
}))).show();
```

**Vollständiges Formularbeispiel**

```javascript
const values = await ui.prompt.form({
  title: "Pflanze hinzufügen",
  submitText: "Hinzufügen",
  fields: {
    name: { type: "text", label: "Pflanzenname", required: true, placeholder: "Tomate" },
    notes: { type: "textarea", label: "Notizen", rows: 3 },
    count: { type: "number", label: "Setzlinge", min: 0, default: 1 },
    perennial: { type: "boolean", label: "Mehrjährig", default: false },
    status: { type: "select", label: "Status", options: ["planned", "sown", "planted"], default: "planned" },
  },
});

if (!values) return;
await current.table("plants")?.add(values.name, values.status, values.count, values.notes);
ui.toast("Pflanze hinzugefügt", { variant: "success" });
```

**Gemeinsamer Zustand mit current.kv**

```javascript
const slot = ui.col();
slot.show();

const render = () => {
  const value = current.kv.get("counter") ?? 0;
  slot.replaceChildren(
    ui.row(
      ui.text("Gemeinsamer Zähler: " + value),
      ui.button("+1", () => current.kv.set("counter", (current = 0) => current + 1)),
      ui.button("Zurücksetzen", () => current.kv.delete("counter")),
    ),
  );
};

render();
current.kv.observe("counter", render);
```

**Anhänge hochladen und einfügen**

```javascript
const files = await nb.attachments.uploadFromPicker({ accept: "image/*", multiple: true });

for (const file of files) {
  await nb.attachments.insertIntoContent(file.id);
}

ui.toast(files.length + (files.length === 1 ? " Datei eingefügt" : " Dateien eingefügt"), { variant: "success" });
```
