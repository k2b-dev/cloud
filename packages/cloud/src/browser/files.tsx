import { createFileChoosing } from "./choose-files";
import { loadFileProviders } from "./file-providers";
import { createProviderList } from "./provider-list";
import { createFileSaving } from "./save-files";

export type { ChooseFilesOptions } from "./FileChooser";
export { SAVE_FILES_ICON, type SavedFile, type SaveFileSource, type SaveFilesOptions } from "./save-files";

const pageLocale = () => (typeof document === "undefined" ? "en" : document.documentElement.lang || "en");
const providers = createProviderList(() => loadFileProviders({ locale: pageLocale() }));
const saving = createFileSaving(providers);

/**
 * Lets the user choose files from this device or from any Cloud application that offers files.
 *
 * Call it from the click or key handler of your attach action. Without providers it opens the device's file
 * dialog directly; otherwise it opens the source chooser, "This device" first. Files from a provider are read
 * through its stream, at most two at a time, and never above `min(maxBytes, provider limit)`. Hand the result
 * to your existing upload path: it resolves the chosen `File`s, or `[]` when the user cancels.
 */
export const chooseFiles = createFileChoosing(providers);

/**
 * Lets the user save copies of files into any Cloud application that stores files, such as Files.
 *
 * Pass each file's name and its bytes as a `Blob`, or a same-origin URL such as your download route; the dialog
 * reads a URL only after the person chose a folder. The person picks the app and a folder, then each file is
 * created there through the app's `save`, at most two at a time and never above the app's limit. Saving never
 * replaces a file: a taken name asks for another. It resolves the saved files, and a confirmation links to them.
 */
export const saveFiles = saving.saveFiles;

/**
 * The label of a save action for menus: "Save to Files" when one app stores files, otherwise "Save to…". Pass the
 * request locale; `name` names one file, and `all` saves every file of a list.
 */
export const saveFilesLabel = saving.label;

/** An icon button that calls `saveFiles(files())`, labelled with `saveFilesLabel`. Takes the props of `IconButton`. */
export const SaveFilesButton = saving.SaveFilesButton;

// Discovery starts while the page is idle, so the first click already knows whether providers exist.
if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 1_000));
  idle(() => providers.prefetch());
}
