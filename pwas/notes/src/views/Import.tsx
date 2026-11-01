import { files as browserFiles } from "@k2b/stdlib/browser";
import { Button, toast } from "@k2b/ui";
import { createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import { applyImport, type ImportPreview, readImport } from "../lib/transfer";
import { app, t } from "../state";
import { Icon } from "../ui/common";
import { openSheet } from "../ui/sheet";

type Mode = "skip" | "replace" | "both";

const errorText = (error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "too_large") return t().importTooLarge;
  if (code === "too_many") return t().importTooMany;
  if (code === "unsafe_path") return t().importUnsafe;
  return t().importInvalid;
};

const acceptable = (file: File) => /\.(zip|md|markdown|txt)$/i.test(file.name);

function ImportBody(props: { close: () => void; initial?: File[] }) {
  const [preview, setPreview] = createSignal<ImportPreview | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [reading, setReading] = createSignal(false);
  const [mode, setMode] = createSignal<Mode>("skip");
  const [over, setOver] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const read = async (list: File[]) => {
    const store = app.store();
    if (!store || list.length === 0) return;
    setError(null);
    setReading(true);
    try {
      setPreview(await readImport(list, store));
    } catch (failure) {
      setPreview(null);
      setError(errorText(failure));
    } finally {
      setReading(false);
    }
  };
  if (props.initial) void read(props.initial);

  const pick = async () => {
    try {
      const picked = await browserFiles.showFileDialog({ accept: ".zip,.md,.markdown,text/markdown,application/zip", multiple: true });
      await read(picked);
    } catch {
      // Closing the picker is not an error.
    }
  };

  const importNow = async () => {
    const store = app.store();
    const current = preview();
    if (!store || !current) return;
    setBusy(true);
    try {
      const result = await applyImport(current, store, mode());
      props.close();
      if (result.skipped > 0)
        toast.success(t().importedSkipped({ count: result.skipped }), { title: t().imported({ count: result.imported }) });
      else toast.success(t().imported({ count: result.imported }));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const importable = () => {
    const current = preview();
    if (!current) return 0;
    return mode() === "skip" ? current.notes - current.duplicates.length : current.notes;
  };

  return (
    <div class="n-dialog">
      <h2>{t().importNotes}</h2>
      <Switch>
        <Match when={preview()}>
          {(current) => (
            <>
              <div class="n-filepick">
                <Icon name={current().name.toLowerCase().endsWith(".zip") ? "ti-file-zip" : "ti-markdown"} />
                <div>
                  <b>{current().name}</b>
                  <span>{t().importSummary({ notes: current().notes, images: current().images })}</span>
                </div>
              </div>
              <Show when={current().duplicates.length > 0}>
                <p class="n-lead" style={{ "margin-top": "1rem" }}>
                  {t().importDuplicates({ count: current().duplicates.length })}
                </p>
                <div class="n-radios" role="radiogroup" style={{ "margin-top": ".5rem" }}>
                  <label>
                    <input type="radio" name="dup" checked={mode() === "skip"} onChange={() => setMode("skip")} />
                    {t().importSkip}
                  </label>
                  <label>
                    <input type="radio" name="dup" checked={mode() === "replace"} onChange={() => setMode("replace")} />
                    {t().importReplace}
                  </label>
                  <label>
                    <input type="radio" name="dup" checked={mode() === "both"} onChange={() => setMode("both")} />
                    {t().importBoth}
                  </label>
                </div>
              </Show>
            </>
          )}
        </Match>
        <Match when={!preview()}>
          <p class="n-lead">{t().importLead}</p>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop area for pointers; "Datei wählen" inside is the keyboard path. */}
          <div
            class="n-drop"
            data-over={over() ? "" : undefined}
            aria-busy={reading()}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOver(false);
              void read([...(event.dataTransfer?.files ?? [])]);
            }}
          >
            <Icon name="ti-file-upload" />
            <span>{t().dropHere}</span>
            <Button variant="secondary" loading={reading()} onClick={() => void pick()}>
              {t().pickFile}
            </Button>
            <span style={{ "font-size": ".8125rem" }}>{t().importLimits}</span>
          </div>
        </Match>
      </Switch>
      <p class="n-error-text" role="alert">
        {error() ?? ""}
      </p>
      <div class="n-dialog-acts">
        <Button variant="ghost" onClick={() => props.close()}>
          {t().cancel}
        </Button>
        <Show when={preview()}>
          <Button variant="primary" loading={busy()} disabled={importable() === 0} onClick={() => void importNow()}>
            {t().importAction({ count: importable() })}
          </Button>
        </Show>
      </div>
    </div>
  );
}

export function openImport(initial?: File[]) {
  void openSheet((close) => <ImportBody close={() => close()} initial={initial} />);
}

/** Files dragged anywhere onto the page start an import; the overlay names what happens on release. */
export function usePageDrop(enabled: () => boolean) {
  const [dragging, setDragging] = createSignal(false);
  let depth = 0;
  const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes("Files");
  const onEnter = (event: DragEvent) => {
    if (!enabled() || !hasFiles(event) || document.querySelector("dialog[open]")) return;
    depth += 1;
    setDragging(true);
  };
  const onLeave = () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) setDragging(false);
  };
  const onOver = (event: DragEvent) => {
    if (hasFiles(event) && dragging()) event.preventDefault();
  };
  const onDrop = (event: DragEvent) => {
    if (!dragging()) return;
    event.preventDefault();
    depth = 0;
    setDragging(false);
    const list = [...(event.dataTransfer?.files ?? [])].filter(acceptable);
    if (list.length > 0) openImport(list);
    else toast.error(t().importInvalid);
  };
  window.addEventListener("dragenter", onEnter);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("dragover", onOver);
  window.addEventListener("drop", onDrop);
  onCleanup(() => {
    window.removeEventListener("dragenter", onEnter);
    window.removeEventListener("dragleave", onLeave);
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("drop", onDrop);
  });
  return dragging;
}
