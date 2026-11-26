/**
 * File picking and disclosure for v2, each one core primitive through the adapter: the file dialog, drops and pastes,
 * the `accept` rule and the form input from core's `fileInput`; open and closed with Enter, Space and the find-in-page
 * of a closed panel from core's `collapsible`. The v2 primitives add the look; no ui-sdk type crosses these exports.
 */
import { collapsible } from "@ui-sdk/core/collapsible";
import { fileInput } from "@ui-sdk/core/file-input";
import { type SlotComponent, slotComponent, usePrimitive } from "./adapter";

export type FilePickOptions = {
  /** Called with the files a person picked, dropped or pasted that pass `accept`. */
  onValueChange?: (files: File[]) => void;
  /** Called with files that `accept` or `maxSize` ruled out. */
  onReject?: (files: File[]) => void;
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

export type DisclosureOptions = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export type DisclosureParts = {
  Root: SlotComponent;
  /** The button that opens and closes the panel; it says whether the panel is open. */
  Trigger: SlotComponent;
  /** The panel; pass `hiddenUntilFound` so find-in-page reaches a closed one. */
  Panel: SlotComponent;
};

export function useDisclosure(options: () => DisclosureOptions): DisclosureParts {
  const handle = usePrimitive(collapsible, options);
  return {
    Root: slotComponent(handle, "root", "div"),
    Trigger: slotComponent(handle, "trigger", "button"),
    Panel: slotComponent(handle, "panel", "div"),
  };
}
