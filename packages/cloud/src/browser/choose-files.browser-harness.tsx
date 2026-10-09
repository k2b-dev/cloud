import { FileDropzone, prompts } from "@k2b/ui";
import { chooseFiles } from "./files";

/**
 * One "Attach" button that calls the real `chooseFiles` for a browser test, which answers the catalog, the
 * provider's Queries, and its read streams. `?single` chooses one file, `?accept=` and `?max=` pass through.
 * Each call gets a fresh signal that `window.abortChoosing()` aborts. Each result lands in `window.chosen` as plain
 * facts. `?dropzone` opens, like Notebooks, a dialog whose `FileDropzone` chooses with
 * `chooseFiles`; what it hands over lands in `window.chosen` the same way.
 */
const params = new URLSearchParams(location.search);
type Chosen = { name: string; type: string; size: number; text: string }[];
const results: Chosen[] = [];
let choosing = new AbortController();
Object.assign(window, { chosen: results, abortChoosing: () => choosing.abort() });

const facts = (files: readonly File[]) =>
  Promise.all(files.map(async (file) => ({ name: file.name, type: file.type, size: file.size, text: await file.text() })));

const button = document.createElement("button");
button.type = "button";
button.id = "attach";
button.textContent = "Attach";
document.body.append(button);
button.addEventListener("click", () => {
  if (params.has("dropzone")) {
    void prompts.dialog<void>(
      () => (
        <div class="k2b-dialog__body">
          <FileDropzone
            title="Attach to the note"
            choose={() => chooseFiles({ multiple: true })}
            onDrop={async (files) => void results.push(await facts(files))}
          />
        </div>
      ),
      { title: "Attach" },
    );
    return;
  }
  choosing = new AbortController();
  void chooseFiles({
    multiple: !params.has("single"),
    accept: params.get("accept") ?? undefined,
    maxBytes: params.has("max") ? Number(params.get("max")) : undefined,
    signal: choosing.signal,
  }).then(async (files) => void results.push(await facts(files)));
});
