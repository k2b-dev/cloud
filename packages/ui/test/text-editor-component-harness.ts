import { LocaleProvider } from "@k2b/ui";
import { TextEditor } from "@k2b/ui/text-editor";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";

const scenario = new URLSearchParams(location.search).get("state") ?? "formatted";
const source =
  "Hallo Jana,\n\n**vielen Dank** für Ihre Anfrage. Hier ist unser Angebot:\n\n| Position | Menge | Preis |\n| :--- | ---: | ---: |\n| Visitenkarten | 500 | 89,00 € |\n| Versand | 1 | 4,90 € |\n\nFreundliche Grüße\nLena";
render(
  () =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(TextEditor, {
          label: "Nachricht",
          initialValue:
            scenario === "check"
              ? source.replace("| Versand | 1 | 4,90 € |", "| Versand | 1 | 4,90 € | Zusätzliche Angabe |")
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
            if (scenario === "table")
              queueMicrotask(() => {
                const cell = controller.view.contentDOM.querySelector<HTMLElement>('.ste-cell[data-r="1"][data-c="0"]');
                cell?.focus();
                cell?.dispatchEvent(new CustomEvent("ste-cell-menu", { bubbles: true, detail: { cell } }));
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
