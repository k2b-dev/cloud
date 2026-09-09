import type { ProjectInput } from "./contracts";
export const starter: ProjectInput = {
  name: "CSV-Werkstatt",
  description: "CSV-Dateien umwandeln und vergangene Exporte lokal wieder öffnen.",
  persistenceEnabled: true,
  files: [
    {
      path: "convert.script.js",
      content: String.raw`export default kit.script({
  name: "CSV umwandeln", icon: "ti ti-table", order: 10,
  run() {
    let rows = [], output = [];
    const status = kit.ui.status("Wähle eine CSV-Datei, um zu beginnen.");
    const table = kit.ui.table({ id: "preview", label: "CSV-Vorschau", columns: [], empty: { title: "Deine Daten erscheinen hier", description: "Wähle links eine CSV-Datei. Die Vorschau zeigt bis zu 100 Zeilen." } });
    const separator = kit.ui.select("Trennzeichen", [
      { value: ";", label: "Semikolon (;)" },
      { value: ",", label: "Komma (,)" },
      { value: "\t", label: "Tabulator" }
    ], ";", "separator");
    const columns = kit.ui.input("Spalten auswählen", {
      id: "columns", placeholder: "z. B. reference:Beleg,amount:Betrag",
      description: "Leer = alle Spalten. Mit alt:neu umbenennen; mehrere Spalten durch Kommas trennen.",
      onChange: () => preview()
    });
    const save = kit.ui.button("CSV exportieren", async () => {
      if (!output.length) return;
      save.setLoading(true);
      try {
        const csv = kit.sheet.toCsv(output, { delimiter: separator.getValue() });
        const filename = "export-" + Date.now() + ".csv";
        await kit.file.save(csv, filename);
        try {
          await kit.opfs.write(filename, csv);
          const history = await kit.store.get("history") || [];
          await kit.store.set("history", [...history, { filename, rows: output.length, createdAt: new Date().toISOString() }]);
          status.setText("Export gespeichert: " + filename);
        } catch (error) {
          status.setText("Download bereit. Der lokale Verlauf konnte nicht gespeichert werden: " + error.message);
        }
      } finally { save.setLoading(false); }
    }, { id: "export", variant: "primary", icon: "ti ti-download", disabled: true });
    function preview() {
      save.setDisabled(true); output = [];
      if (!rows.length) { table.setRows([]); return; }
      try {
        const fields = columns.getValue().split(",").map(s => s.trim()).filter(Boolean);
        const mapping = fields.map(field => field.split(":").map(s => s.trim()));
        const names = mapping.map(([from, to = from]) => to);
        if (names.some(name => !name) || new Set(names).size !== names.length) throw new Error("Ausgabespalten brauchen eindeutige, nicht leere Namen.");
        output = fields.length ? rows.map(row => Object.fromEntries(mapping.map(([from, to = from]) => {
          if (!(from in row)) throw new Error("Unbekannte Spalte: " + from);
          return [to, row[from]];
        }))) : rows;
        table.setColumns(Object.keys(output[0]).map(key => ({ key, label: key })));
        table.setRows(output.slice(0, 100));
        save.setDisabled(false);
        status.setState("ready"); status.setText(rows.length + " Zeilen geladen");
      } catch (error) {
        table.setRows([]); table.setState("error", error.message);
        status.setState("error"); status.setText(error.message);
      }
    }
    const open = kit.ui.filePicker("CSV auswählen", {
      id: "open", accept: ".csv,text/csv", icon: "ti ti-file-type-csv",
      description: "CSV-Datei vom Gerät auswählen. Das Original bleibt unverändert.",
      async onChange(files) {
        rows = []; output = []; save.setDisabled(true); table.setRows([]); table.setState("loading");
        status.setText("Datei wird gelesen…");
        try {
          rows = await kit.sheet.fromCsv(files[0]); preview();
          if (!rows.length) status.setText("Die Datei enthält keine Datenzeilen.");
        } catch (error) {
          table.setState("error", error.message); status.setState("error"); status.setText("Datei konnte nicht gelesen werden: " + error.message);
        }
      }
    });
    kit.ui.workbench({
      controls: [kit.ui.section({ title: "Eingabe" }, [open]), kit.ui.section({ title: "Ausgabe" }, [separator, columns])],
      content: [kit.ui.section({ title: "Vorschau", description: "Spalten auswählen, umbenennen und als Excel-taugliche CSV exportieren." }, [table])],
      footer: { status, actions: [save] }
    });
  }
});
`,
    },
    {
      path: "history.script.js",
      content: String.raw`export default kit.script({
  name: "Vergangene Exporte", icon: "ti ti-history", order: 20,
  async run() {
    const history = await kit.store.get("history") || [];
    const status = kit.ui.status("Exporte auf diesem Gerät: " + history.length);
    const list = kit.ui.list({
      id: "exports", title: "Gespeicherte Exporte",
      description: "Die neuesten 50 Exporte. Bereits erstellte Dateien kannst du erneut herunterladen.",
      empty: { title: "Noch keine Exporte", description: "Erstelle deinen ersten Export unter CSV umwandeln." }
    }, history.slice(-50).reverse().map(item => ({
      id: item.filename, title: item.filename,
      description: item.rows + " Zeilen" + (item.createdAt ? " · " + new Date(item.createdAt).toLocaleString("de-DE") : ""),
      icon: "ti ti-file-type-csv",
      action: kit.ui.button("Herunterladen", async () => {
        const file = await kit.opfs.read(item.filename);
        if (!file) throw new Error("Die Exportdatei ist auf diesem Gerät nicht mehr vorhanden.");
        await kit.file.save(file, item.filename);
        status.setText("Download bereit: " + item.filename);
      }, { icon: "ti ti-download", variant: "secondary" })
    })));
    kit.ui.workbench({
      controls: [kit.ui.section({ title: "Dein Verlauf" }, [kit.ui.markdown("Alle Werkzeuge dieser App teilen denselben lokalen Verlauf.\n\nDie Dateien sind auf **diesem Gerät** gespeichert.")])],
      content: [list], footer: { status }
    });
  }
});
`,
    },
  ],
};
