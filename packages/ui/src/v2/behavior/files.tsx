/**
 * File picking and disclosure for v2, each one core primitive through the adapter: the file dialog, drops and pastes,
 * the `accept` rule and the form input from core's `fileInput`; open and closed with Enter, Space and the find-in-page
 * of a closed panel from core's `collapsible`. The v2 primitives add the look; no ui-sdk type crosses these exports.
 */
import { collapsible } from "@ui-sdk/core/collapsible";
import { fileInput, formatFileSize, relativePath } from "@ui-sdk/core/file-input";
import { type PartProps, part, type SlotComponent, slotComponent, usePrimitive } from "./adapter";

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

export type FilesOptions = {
  value?: File[];
  defaultValue?: File[];
  /** Called with all files after a pick, a drop, a paste, a removal or a form's reset. */
  onValueChange?: (files: File[]) => void;
  /** Called with each file that was ruled out and why: `file-type`, `file-too-large`, `too-many-files`. */
  onReject?: (rejected: { file: File; reasons: string[] }[]) => void;
  announcement?: (change: {
    reason: string;
    added: File[];
    removed: File[];
    rejected: readonly { file: File; reasons: string[] }[];
  }) => string | null;
  /** A check of the app's own: return a reason, such as `folder`, to refuse the file. */
  validate?: (file: File) => string | undefined;
  accept?: string;
  multiple?: boolean;
  maxSize?: number;
  disabled?: boolean;
  required?: boolean;
  name?: string;
};

export type FilesParts = FilePickParts & {
  /** The chosen files, a list with one tab stop: arrows move, Backspace and Delete remove. */
  List: SlotComponent;
  /** One chosen file: pass it as `file` and a stable `value`. */
  Item: (props: PartProps & { file: File; value: string }) => ReturnType<SlotComponent>;
  /** Removes its file: pass the same `file` and `value` as its item. */
  ItemRemove: (props: PartProps & { file: File; value: string }) => ReturnType<SlotComponent>;
};

/** Files a form sends: core holds them in its file input, which is sent, required and reset with the form. */
export function useFiles(options: () => FilesOptions): FilesParts {
  const handle = usePrimitive(fileInput, () => {
    const { onValueChange, onReject, ...rest } = options();
    return {
      ...rest,
      onValueChange: (files: File[]) => onValueChange?.(files),
      onReject: (rejected: { file: File; reasons: string[] }[]) => onReject?.(rejected),
    };
  });
  const keyedPart = (slot: "item" | "item-remove", tag: string) => (props: PartProps & { file: File; value: string }) => {
    const { file, value, ...element } = props;
    return part(handle, slot, () => ({ file, value }), element, tag);
  };
  return {
    Root: slotComponent(handle, "root", "div"),
    Trigger: slotComponent(handle, "trigger", "button"),
    Input: slotComponent(handle, "input", "input"),
    Dropzone: slotComponent(handle, "dropzone", "div"),
    List: slotComponent(handle, "list", "div"),
    Item: keyedPart("item", "div"),
    ItemRemove: keyedPart("item-remove", "button"),
  };
}

/** A file size in the page's language, as the core writes it: "820 Byte", "12 kB", "3,1 MB". */
export const fileSize = (bytes: number, locale: string): string => formatFileSize(bytes, locale);

/** Where a file sat in a dropped folder ("Belege/2026/a.pdf"); just its name for a file on its own. */
export const relativePathOf = (file: File): string => relativePath(file);

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
