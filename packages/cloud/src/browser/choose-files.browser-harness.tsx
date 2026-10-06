import { chooseFiles } from "./files";

/**
 * One "Attach" button that calls the real `chooseFiles` for a browser test, which answers the catalog, the
 * provider's Queries, and its read streams. `?single` chooses one file, `?accept=` and `?max=` pass through.
 * Each call gets a fresh signal that `window.abortChoosing()` aborts. Each result lands in `window.chosen` as plain
 * facts.
 */
const params = new URLSearchParams(location.search);
type Chosen = { name: string; type: string; size: number; text: string }[];
const results: Chosen[] = [];
let choosing = new AbortController();
Object.assign(window, { chosen: results, abortChoosing: () => choosing.abort() });

const button = document.createElement("button");
button.type = "button";
button.id = "attach";
button.textContent = "Attach";
document.body.append(button);
button.addEventListener("click", () => {
  choosing = new AbortController();
  void chooseFiles({
    multiple: !params.has("single"),
    accept: params.get("accept") ?? undefined,
    maxBytes: params.has("max") ? Number(params.get("max")) : undefined,
    signal: choosing.signal,
  }).then(async (files) => {
    results.push(
      await Promise.all(files.map(async (file) => ({ name: file.name, type: file.type, size: file.size, text: await file.text() }))),
    );
  });
});
