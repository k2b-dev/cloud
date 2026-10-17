import { AppWorkspace } from "@k2b/ui";
import { render } from "solid-js/web";
import { ImageConverterView } from "./ImageConverter.island";

declare global {
  interface Window {
    releaseDecodes: () => void;
  }
}
// Hold real worker jobs until the test has measured the loading cards.
const NativeWorker = globalThis.Worker;
const pending: (() => void)[] = [];
let released = false;
globalThis.Worker = class extends NativeWorker {
  override postMessage(message: unknown, transferOrOptions: Transferable[] | StructuredSerializeOptions = {}): void {
    const send = () => {
      if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
      else super.postMessage(message, transferOrOptions);
    };
    if (released) send();
    else pending.push(send);
  }
};
window.releaseDecodes = () => {
  released = true;
  for (const send of pending.splice(0)) send();
};
render(
  () => (
    <AppWorkspace aria-label="Image tools">
      <ImageConverterView />
    </AppWorkspace>
  ),
  document.getElementById("root")!,
);
