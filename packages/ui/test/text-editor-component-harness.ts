import { type DictationEvent, type DictationSource, LocaleProvider } from "@k2b/ui";
import { TextEditor } from "@k2b/ui/text-editor";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";

const scenario = new URLSearchParams(location.search).get("state") ?? "formatted";
const defaultSource =
  "Hallo Jana,\n\n**vielen Dank** für Ihre Anfrage. Hier ist unser Angebot:\n\n| Position | Menge | Preis |\n| :--- | ---: | ---: |\n| Visitenkarten | 500 | 89,00 € |\n| Versand | 1 | 4,90 € |\n\nFreundliche Grüße\nLena";
// The table polish fixture: the fictional table of the approved mockup, with a multi-line row.
const polish = [
  "# Sommerfest 2027",
  "",
  "Wer kümmert sich um was, und was kostet es? Stand nach dem Treffen am Dienstag.",
  "",
  "| Aufgabe | Wer | Budget | Status | Notiz |",
  "| --- | --- | --: | --- | --- |",
  "| Bühne und Technik | Mara | 1.200 € | offen | Angebot von zwei Verleihern einholen, Termin bis Ende März klären |",
  "| Getränke | Jonas | 640 € | erledigt | |",
  "| Essen und Grill | Leni | 820 € | in Arbeit | Vegetarische Auswahl einplanen |",
  "| Deko und Licht | Tarek | 310 € | offen | Lichterketten aus dem Lager holen |",
  "| **Summe** | | **2.970 €** | | |",
  "",
  "Die Liste gehen wir am Freitag noch einmal durch.",
].join("\n");
// The screenshot fixture uses the exact fictional text from the approved mockup.
const source = new URLSearchParams(location.search).has("polish")
  ? polish
  : new URLSearchParams(location.search).has("mockup")
    ? [
        "Liebe Frau Berger,",
        "",
        "vielen Dank für das überarbeitete Angebot. Für die drei Formate planen wir so:",
        "",
        "| Format | Auflage | Papier | Preis |",
        "| --- | --: | --- | --: |",
        "| Visitenkarte | 500 | 350 g Naturpapier | 89,00 € |",
        "| Briefbogen | 1.000 | 120 g Offset | 142,00 € |",
        "| Klappkarte | 250 | 300 g matt | 118,50 € |",
        "",
        "**Wichtig:** Die Lackfläche auf dem Logo bleibt wie im *Proof*. Die Druckdaten liegen [im Ordner Druck](https://linden.example/druck).",
        "",
        "- Freigabe bis Mittwoch",
        "- Lieferung an das Lager in Köln",
        "",
        "Viele Grüße",
        "Lena Schulz",
      ].join("\n")
    : defaultSource;

// `?state=dictation`: a scripted source; the test pushes its events through `window.dictationEmit`.
const dictationSource: DictationSource = {
  devices: async () => [],
  start: ({ signal }) => {
    const queue: DictationEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    (window as unknown as { dictationEmit: (event: DictationEvent) => void }).dictationEmit = (event) => {
      queue.push(event);
      wake?.();
    };
    signal.addEventListener("abort", () => {
      ended = true;
      wake?.();
    });
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          while (!ended) {
            const event = queue.shift();
            if (event) yield event;
            else await new Promise<void>((done) => (wake = done));
          }
        },
      },
      stop: async () => {},
    };
  },
};

render(
  () =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(TextEditor, {
          label: "Nachricht",
          initialValue:
            scenario === "check"
              ? source.replace(/(\| (?:Versand|Klappkarte) [^\n]+)/, "$1 Zusätzliche Angabe |")
              : scenario === "empty"
                ? ""
                : source,
          mode: scenario === "source" ? "source" : scenario === "plain" ? "plain" : "formatted",
          loading: scenario === "loading",
          readOnly: scenario === "readonly",
          placeholder: "Nachricht schreiben …",
          maxLength: scenario === "error" ? source.length : 2097152,
          status: "Gespeichert",
          dictation: scenario === "dictation" ? { source: dictationSource } : undefined,
          onReady: (controller) => {
            window.sharedComponentHarness = controller;
            if (scenario === "formatted" && new URLSearchParams(location.search).has("mockup")) {
              const at = source.indexOf("überarbeitete");
              controller.view.dispatch({ selection: { anchor: at, head: at + 13 } });
              controller.view.focus();
            }
            if (scenario === "table")
              queueMicrotask(() => {
                const cell = controller.view.contentDOM.querySelector<HTMLElement>('.k2b-ste-cell[data-r="1"][data-c="0"]');
                cell?.focus();
                cell?.dispatchEvent(new CustomEvent("k2b-ste-cell-menu", { bubbles: true, detail: { cell } }));
              });
          },
        });
      },
    }),
  document.getElementById("root")!,
);
declare global {
  interface Window {
    sharedComponentHarness: import("../src/text-editor/engine").TextEditorController;
  }
}
