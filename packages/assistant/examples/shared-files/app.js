// Configure shared KV `sources` with discovered IDs before starting this Studio app.
const status = document.querySelector("#status");
const rows = document.querySelector("#rows");
const sources = await cloud.kv.get("sources");
const pages = { grids: [], files: [] };
const cursors = { grids: undefined, files: undefined };
let selected;
let busy = false;

const render = () => {
  rows.innerHTML = cloud.html`${[...pages.grids, ...pages.files].map(
    (row) =>
      cloud.html`<tr><td><label><input type="radio" name="file" value="${row.key}" ${row.key === selected?.key ? "checked" : ""}> ${row.name}</label></td><td>${row.source}</td></tr>`,
  )}`;
};
rows.addEventListener("change", (event) => {
  selected = [...pages.grids, ...pages.files].find((row) => row.key === event.target.value);
  status.textContent = selected ? `Selected: ${selected.name}` : "Select a file.";
});

async function load(source, first = false) {
  if (busy) return;
  if (!first && !cursors[source]) {
    status.textContent = "No further page for this source.";
    return;
  }
  busy = true;
  try {
    if (source === "grids") {
      const result = await cloud.capabilities.run("grids.document.list", {
        templateId: sources.gridsTemplateId,
        limit: 100,
        ...(cursors.grids ? { cursor: cursors.grids } : {}),
      });
      pages.grids = result.data.map((item) => ({ key: `grids:${item.id}`, id: item.id, name: item.filename, source: "Grids" }));
      cursors.grids = result.page?.hasMore ? result.page.nextCursor : undefined;
    } else {
      const result = await cloud.capabilities.run("filesv2.entry.list", {
        baseId: sources.filesBaseId,
        path: sources.filesPath ?? "",
        type: "files",
        ...(cursors.files ? { after: cursors.files } : {}),
      });
      pages.files = result.data.items.map((item) => ({ key: `files:${item.ref.id}`, id: item.ref.id, name: item.name, source: "Files" }));
      cursors.files = result.data.next;
    }
    selected = undefined;
    render();
    status.textContent = `${source === "grids" ? "Grids" : "Files"}: page loaded. ${cursors[source] ? "More entries available." : "Last page."}`;
  } catch (error) {
    status.textContent = `Could not load this source: ${error.message}`;
  } finally {
    busy = false;
  }
}

async function download() {
  if (busy || !selected) return;
  busy = true;
  const row = selected;
  try {
    const result = await cloud.capabilities.run(row.source === "Grids" ? "grids.document.content.read" : "filesv2.content.read", {
      id: row.id,
    });
    const file = await cloud.capabilities.streams.read(result.stream);
    await cloud.download(file.name, file);
    status.textContent = `Downloaded: ${row.name}`;
  } catch (error) {
    status.textContent = `Download failed: ${error.message}`;
  } finally {
    busy = false;
  }
}

if (!sources?.gridsTemplateId || !sources?.filesBaseId) {
  status.textContent = "Configure sources.gridsTemplateId and sources.filesBaseId first.";
  for (const button of document.querySelectorAll("button")) button.disabled = true;
} else {
  document.querySelector("#next-grids").addEventListener("click", () => load("grids"));
  document.querySelector("#next-files").addEventListener("click", () => load("files"));
  document.querySelector("#download").addEventListener("click", download);
  await load("grids", true);
  await load("files", true);
}
