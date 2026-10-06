import { createFileChoosing } from "./choose-files";
import { loadFileProviders } from "./file-providers";

export type { ChooseFilesOptions } from "./FileChooser";

const pageLocale = () => (typeof document === "undefined" ? "en" : document.documentElement.lang || "en");
const choosing = createFileChoosing(() => loadFileProviders({ locale: pageLocale() }));

/**
 * Lets the user choose files from this device or from any Cloud application that offers files.
 *
 * Call it from the click or key handler of your attach action. Without providers it opens the device's file
 * dialog directly; otherwise it opens the source chooser, "This device" first. Files from a provider are read
 * through its stream, at most two at a time, and never above `min(maxBytes, provider limit)`. Hand the result
 * to your existing upload path: it resolves the chosen `File`s, or `[]` when the user cancels.
 */
export const chooseFiles = choosing.chooseFiles;

// Discovery starts while the page is idle, so the first click already knows whether providers exist.
if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 1_000));
  idle(() => choosing.prefetch());
}
