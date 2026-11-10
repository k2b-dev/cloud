import { createSignal } from "solid-js";

/**
 * The detail level's head actions live outside the detail island, so both read one store: the island registers what
 * it can do, the head island renders the controls. Both are modules of one page bundle.
 */
export type StorageDetailControls = {
  test?: { busy: boolean; disabled?: boolean; run: () => void };
  remove?: { disabled?: boolean; run: () => void };
  save?: { label: string; dirty: boolean; saving: boolean; disabled?: boolean; run: () => void };
  restore?: { busy: boolean; disabled?: boolean; run: () => void };
};

const [controls, setControls] = createSignal<StorageDetailControls | null>(null);
export const storageDetailControls = controls;
export const setStorageDetailControls = setControls;
