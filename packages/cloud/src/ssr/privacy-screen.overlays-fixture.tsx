import { dialogCore, FloatingWindow, openFloatingWindow, toast } from "@k2b/ui";
import { render } from "solid-js/web";

/**
 * Every overlay layer `@k2b/ui` offers, open over the privacy fixture with fictional content: a window maximized over
 * the app area as Mail writes large, a normal window, a modeless dialog, a toast, and with `modal` a modal dialog above
 * them, which then hosts the privacy hint. The privacy test checks that each of them is covered.
 */
export const mountOverlays = (modal: boolean) => {
  const host = document.createElement("div");
  document.querySelector("#subject")!.after(host);
  render(
    () => (
      <FloatingWindow
        title="Angebot Lindner"
        state="maximized"
        area={() => document.querySelector<HTMLElement>("[data-cloud-app-area]")}
        onClose={() => undefined}
      >
        <p id="overlay-maximized">Sehr geehrte Frau Lindner, anbei das Angebot über 18.400 €.</p>
      </FloatingWindow>
    ),
    host,
  );
  openFloatingWindow(() => <p id="overlay-window">Notiz: Gehaltsrunde im Dezember</p>, { title: "Notiz" });
  void dialogCore.open((_close, context) => {
    context.setModal(false);
    return <p id="overlay-modeless">Vertrag Brandt, Kündigung zum 31.12.</p>;
  });
  if (modal) void dialogCore.open(() => <p id="overlay-dialog">Kontostand 12.840 €</p>);
  toast("Überweisung an Lea Brandt ausgeführt", { title: "Bank" });
};
