import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./main.js", import.meta.url)).text();
async function harness(deny = false) {
  const buttons = new Map();
  const messages = [];
  let table;
  let rows = [];
  const calls = [];
  const saved = [];
  const file = new File(["pdf"], "invoice.pdf", { type: "application/pdf" });
  const ui = {
    text: ({ value }) => {
      messages.push(value);
      return { setValue: (value) => messages.push(value) };
    },
    table: (options) => {
      table = options;
      return {
        setData: (value) => {
          rows = value;
        },
      };
    },
    button: (options) => buttons.set(options.label, options.onClick),
  };
  const capabilities = {
    run: async (name, input) => {
      calls.push([name, input]);
      if (name === "grids.document.list")
        return { data: [{ id: "same-id", filename: "invoice.pdf" }], page: { hasMore: true, nextCursor: "g-next" } };
      if (name === "filesv2.entry.list") return { data: { items: [{ ref: { id: "same-id" }, name: "contract.pdf" }], next: null } };
      if (deny) throw new Error("Access denied");
      return { stream: { id: "current-run" } };
    },
    streams: {
      read: async (stream) => {
        expect(stream.id).toBe("current-run");
        return file;
      },
    },
  };
  const run = new Function("ui", "kv", "capabilities", "files", source.replace("export default", "return"))(
    ui,
    { shared: { get: async () => ({ gridsTemplateId: "Tpl001", filesBaseId: "base" }) } },
    capabilities,
    { save: async (content, name) => saved.push({ content, name }) },
  );
  await run();
  return { buttons, calls, saved, messages, rows: () => rows, select: (index) => table.onSelect(rows[index]) };
}

test("combines source-local identities, paginates explicitly and downloads through each source's stream", async () => {
  const app = await harness();
  expect(app.rows().map((row) => row.key)).toEqual(["grids:same-id", "files:same-id"]);
  for (const index of [0, 1]) {
    app.select(index);
    await app.buttons.get("Download selected file")();
  }
  expect(app.calls.slice(2).map((call) => call[0])).toEqual(["grids.document.content.read", "filesv2.content.read"]);
  expect(app.saved).toHaveLength(2);
  expect(app.saved[0].name).toBe("invoice.pdf");
  await app.buttons.get("Next Grids page")();
  expect(app.calls.at(-1)).toEqual(["grids.document.list", { templateId: "Tpl001", limit: 100, cursor: "g-next" }]);
  const count = app.calls.length;
  await app.buttons.get("Next Files page")();
  expect(app.calls).toHaveLength(count);
});

test("denied reads never save bytes and explain the failure", async () => {
  const app = await harness(true);
  app.select(0);
  await app.buttons.get("Download selected file")();
  expect(app.saved).toHaveLength(0);
  expect(app.messages.at(-1)).toBe("Download failed: Access denied");
});
