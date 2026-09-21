// Configure shared KV `sources` with discovered IDs before running this Studio app.
export default async () => {
  const sources = await kv.shared.get("sources");
  if (!sources?.gridsTemplateId || !sources?.filesBaseId) {
    ui.text({ value: "Configure sources.gridsTemplateId and sources.filesBaseId first." });
    return;
  }
  ui.text({ value: "Files and documents" });
  const status = ui.text({ value: "Select a file, then download it. Each source shows one page." });
  let selected;
  let busy = false;
  const pages = { grids: [], files: [] };
  const cursors = { grids: undefined, files: undefined };
  const table = ui.table({
    id: "files",
    rowKey: "key",
    rows: [],
    columns: [
      { key: "name", label: "File" },
      { key: "source", label: "Source" },
    ],
    onSelect(row) {
      selected = row;
      status.setValue(row ? `Selected: ${row.name}` : "Select a file.");
    },
  });
  async function load(source, first = false) {
    if (busy) return;
    if (!first && !cursors[source]) {
      status.setValue("No further page for this source.");
      return;
    }
    busy = true;
    try {
      if (source === "grids") {
        const result = await capabilities.run("grids.document.list", {
          templateId: sources.gridsTemplateId,
          limit: 100,
          ...(cursors.grids ? { cursor: cursors.grids } : {}),
        });
        pages.grids = result.data.map((item) => ({ key: `grids:${item.id}`, id: item.id, name: item.filename, source: "Grids" }));
        cursors.grids = result.page?.hasMore ? result.page.nextCursor : undefined;
      } else {
        const result = await capabilities.run("filesv2.entry.list", {
          baseId: sources.filesBaseId,
          path: sources.filesPath ?? "",
          type: "files",
          ...(cursors.files ? { after: cursors.files } : {}),
        });
        pages.files = result.data.items.map((item) => ({ key: `files:${item.ref.id}`, id: item.ref.id, name: item.name, source: "Files" }));
        cursors.files = result.data.next;
      }
      selected = undefined;
      table.setData([...pages.grids, ...pages.files]);
      status.setValue(
        `${source === "grids" ? "Grids" : "Files"}: page loaded. ${cursors[source] ? "More entries available." : "Last page."}`,
      );
    } catch (error) {
      status.setValue(`Could not load this source: ${error.message}`);
    } finally {
      busy = false;
    }
  }
  ui.button({ label: "Next Grids page", onClick: () => load("grids") });
  ui.button({ label: "Next Files page", onClick: () => load("files") });
  ui.button({
    label: "Download selected file",
    onClick: async () => {
      if (busy || !selected) return;
      busy = true;
      const row = selected;
      try {
        const result = await capabilities.run(row.source === "Grids" ? "grids.document.content.read" : "filesv2.content.read", {
          id: row.id,
        });
        const file = await capabilities.streams.read(result.stream);
        await files.save(file, file.name);
        status.setValue(`Downloaded: ${row.name}`);
      } catch (error) {
        status.setValue(`Download failed: ${error.message}`);
      } finally {
        busy = false;
      }
    },
  });
  await load("grids", true);
  await load("files", true);
};
