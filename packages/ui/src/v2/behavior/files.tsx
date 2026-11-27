/**
 * File picking for v2, one core primitive through the adapter: the file dialog, drops and pastes, the `accept` rule and
 * the form input from core's `fileInput`. The v2 primitives add the look; no ui-sdk type crosses these exports.
 */
import { fileInput } from "@ui-sdk/core/file-input";
import { type SlotComponent, slotComponent, usePrimitive } from "./adapter";

export type FilePickOptions = {
  /** Called with the files a person picked, dropped or pasted that pass `accept`. */
  onValueChange?: (files: File[]) => void;
  /** Called with files that `accept` or `maxSize` ruled out. */
  onReject?: (files: File[]) => void;
  /** What assistive technology hears after a pick, in the page's language; `null` says nothing. */
  announcement?: (change: { added: File[]; rejected: readonly unknown[] }) => string | null;
  accept?: string;
  maxSize?: number;
  disabled?: boolean;
  required?: boolean;
  name?: string;
};

export type FilePickParts = {
  Root: SlotComponent;
  /** A button that opens the device's file dialog. */
  Trigger: SlotComponent;
  /** The hidden file input the dialog fills; a form sends it. */
  Input: SlotComponent;
  /** An element that takes dropped and pasted files. */
  Dropzone: SlotComponent;
};

/**
 * One file at a time. The picker holds no files itself (its value stays empty): the caller turns the picked file into
 * its own value, so the same file can be picked again.
 */
export function useFilePick(options: () => FilePickOptions): FilePickParts {
  const handle = usePrimitive(fileInput, () => {
    const { onValueChange, onReject, ...rest } = options();
    return {
      ...rest,
      value: [],
      multiple: false,
      onValueChange: (files: File[]) => onValueChange?.(files),
      onReject: (rejected: { file: File }[]) => onReject?.(rejected.map((entry) => entry.file)),
    };
  });
  return {
    Root: slotComponent(handle, "root", "div"),
    Trigger: slotComponent(handle, "trigger", "button"),
    Input: slotComponent(handle, "input", "input"),
    Dropzone: slotComponent(handle, "dropzone", "div"),
  };
}
