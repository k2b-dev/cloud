import { render } from "solid-js/web";
import { SaveFilesButton, saveFiles } from "./files";

/**
 * Buttons that call the real `saveFiles` for a browser test, which answers the catalog, the provider's Queries and
 * Action, and its write streams. `#save` saves one attachment by URL, `#save-all` two, `#save-big` one above the
 * provider's limit. Each call gets a fresh signal that `window.abortSaving()` aborts. Each result lands in
 * `window.saved`. `SaveFilesButton` renders the shared icon button for the same attachment.
 */
type Saved = Awaited<ReturnType<typeof saveFiles>>;
const results: Saved[] = [];
let saving = new AbortController();
Object.assign(window, { saved: results, abortSaving: () => saving.abort() });

const attachment = (name: string) => ({ name, content: `/source/${encodeURIComponent(name)}` });
const sets: Record<string, Parameters<typeof saveFiles>[0]> = {
  save: [attachment("report.pdf")],
  "save-all": [attachment("report.pdf"), attachment("notes.txt")],
  "save-big": [{ ...attachment("huge.zip"), size: 5_000 }],
};
for (const [id, files] of Object.entries(sets)) {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.textContent = id;
  document.body.append(button);
  button.addEventListener("click", () => {
    saving = new AbortController();
    void saveFiles(files, { signal: saving.signal }).then((saved) => void results.push(saved));
  });
}
const icon = document.createElement("div");
icon.id = "icon";
document.body.append(icon);
render(() => <SaveFilesButton files={() => sets.save!} />, icon);
