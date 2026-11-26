import { LocaleProvider } from "@k2b/ui";
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
// `?many` starts with 1,000 ready images, so a test can count the rows in the page.
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQaPgPAAIzAZDtHsO2AAAAAElFTkSuQmCC";
const search = new URLSearchParams(location.search);
const initialItems: ImageConverterItem[] | undefined = search.has("failures")
  ? reasons.map((reason) => ({ status: "failed", id: reason, file: new File(["x"], `${reason}.heic`), reason }))
  : search.has("many")
    ? Array.from({ length: 1_000 }, (_, index) => {
        const file = new File(["x"], `IMG_${String(index + 1).padStart(4, "0")}.png`, { type: "image/png" });
        return {
          status: "ready",
          id: `many-${index}`,
          file,
          source: file,
          previewUrl: pixel,
          width: 4032,
          height: 3024,
          rotation: 0,
          selected: false,
        };
      })
    : undefined;
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang}>
      <ImageConverterView initialItems={initialItems} />
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
