import { LocaleProvider } from "@k2b/ui";
import { TextEditor } from "@k2b/ui/text-editor";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";

const scenario = new URLSearchParams(location.search).get("state") ?? "formatted";
const defaultSource =
  "Hallo Jana,\n\n**vielen Dank** für Ihre Anfrage. Hier ist unser Angebot:\n\n| Position | Menge | Preis |\n| :--- | ---: | ---: |\n| Visitenkarten | 500 | 89,00 € |\n| Versand | 1 | 4,90 € |\n\nFreundliche Grüße\nLena";
// The screenshot fixture uses the exact fictional text from the approved mockup.
const source = new URLSearchParams(location.search).has("mockup")
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
