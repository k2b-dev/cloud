import { Dialog } from "../src/v2";

// Another island: its own copy of `@k2b/ui` (a bundle of its own), with no Workspace of its own. `__k2AskOther()` asks
// `Dialog.confirm` from this copy and writes the answer to `<body data-other>`.

declare global {
  interface Window {
    __k2AskOther?: () => void;
  }
}

window.__k2AskOther = () =>
  void Dialog.confirm({ title: "Aus der Insel?", confirm: "Ja" }).then((answer) => {
    document.body.dataset.other = String(answer);
  });
