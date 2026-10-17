import { AppWorkspace } from "@k2b/ui";
import { render } from "solid-js/web";
import { type ImageConverterItem, ImageConverterView } from "./ImageConverter.island";
import type { ImageIntakeFailure } from "./image-intake/intake";

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
// `?failures` starts with one failed card per reason, so a test can measure every recovery text.
const reasons: ImageIntakeFailure["reason"][] = ["unsupported", "too-large", "decode-failed", "decoder-unavailable"];
const initialItems: ImageConverterItem[] | undefined = new URLSearchParams(location.search).has("failures")
  ? reasons.map((reason) => ({ status: "failed", id: reason, file: new File(["x"], `${reason}.heic`), reason }))
  : undefined;
render(
  () => (
    <AppWorkspace aria-label="Image tools">
      <ImageConverterView initialItems={initialItems} />
    </AppWorkspace>
  ),
  document.getElementById("root")!,
);
