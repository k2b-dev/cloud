import { createSignal, type JSX } from "solid-js";
import { checkMimeType } from "../browser/files";

// ==========================
// Types
// ==========================

export type DropzoneOptions = {
  /** Called when valid files are dropped */
  onDrop?: (files: File[]) => void;
  /** MIME types to accept (e.g., "image/*", "image/jpeg,image/png") */
  accept?: string;
};

export type DropzoneHandlers = {
  onDragEnter: JSX.EventHandler<HTMLElement, DragEvent>;
  onDragLeave: JSX.EventHandler<HTMLElement, DragEvent>;
  onDragOver: JSX.EventHandler<HTMLElement, DragEvent>;
  onDrop: JSX.EventHandler<HTMLElement, DragEvent>;
};

// ==========================
// Dropzone
// ==========================

/**
 * Creates a headless dropzone with drag and drop file handling.
 *
 * Uses a drag counter pattern to correctly track drag state with nested elements:
 * each `dragenter` increments the counter and each `dragleave` decrements it.
 * The zone is considered "dragging" as long as the counter is above zero. This
 * avoids false negatives from `dragleave` events that fire when the pointer
 * moves between child elements within the drop zone.
 *
 * @param options - Dropzone configuration options
 * @returns Object with isDragging/invalidDrag signals and event handlers
 *
 * @example
 * const { isDragging, invalidDrag, handlers } = dropzone.create({
 *   onDrop: (files) => console.log("Dropped:", files),
 *   accept: "image/*",
 * });
 * return <div {...handlers}>Drop files here</div>;
 */
const create = (options: DropzoneOptions) => {
  const [invalidDrag, setInvalidDrag] = createSignal(false);
  const [dragCounter, setDragCounter] = createSignal(0);
  const isDragging = () => dragCounter() > 0;

  const validateFiles = (files: File[]): { valid: File[] } => {
    if (!options.accept) return { valid: files };
    return {
      valid: files.filter((file) => checkMimeType(file, options.accept!)),
    };
  };

  const handlers: DropzoneHandlers = {
    onDragEnter: (e) => {
      e.preventDefault();
      e.stopPropagation();

      // A drag is a file-drag only when the dataTransfer actually contains
      // files. The `Files` entry in `types` is the canonical signal; the
      // fallback walks `items` looking for `kind === 'file'`. Plain text /
      // link drags previously triggered the file-drop UI because we used
      // `items.length > 0`.
      const hasFiles =
        e.dataTransfer?.types?.includes("Files") ||
        (e.dataTransfer?.items
          ? Array.from(e.dataTransfer.items).some((item) => item.kind === "file")
          : false);
      if (!hasFiles) return;

      setDragCounter((prev) => prev + 1);

      if (!(options.accept && e.dataTransfer?.items)) return;
      const hasInvalidFile = Array.from(e.dataTransfer.items)
        .filter((item) => item.kind === "file")
        .some((f) => !checkMimeType(f.type, options.accept!));
      setInvalidDrag(hasInvalidFile);
    },

    onDragLeave: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const newCount = Math.max(0, dragCounter() - 1);
      setDragCounter(newCount);
      if (newCount === 0) setInvalidDrag(false);
    },

    onDragOver: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = invalidDrag() ? "none" : "copy";
      }
    },

    onDrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setInvalidDrag(false);
      setDragCounter(0);

      const droppedFiles = e.dataTransfer?.files;
      if (!droppedFiles || droppedFiles.length === 0) return;

      const { valid } = validateFiles(Array.from(droppedFiles));
      if (valid.length === 0) return;

      options.onDrop?.(valid);
    },
  };

  return { isDragging, invalidDrag, handlers };
};

export const dropzone = {
  create,
} as const;
