import { createSignal } from "solid-js";

/**
 * The detail column's head actions live in the level head, outside the detail island, so both read one store:
 * the island registers what it can do, the head island renders the controls. Both are modules of one page bundle.
 */
export type AiDetailControls = {
  enabled?: { value: boolean; disabled?: boolean; onChange: (value: boolean) => void };
  test?: { label: string; busy: boolean; disabled?: boolean; run: () => void };
  save: { dirty: boolean; saving: boolean; disabled?: boolean; run: () => void };
};

const [controls, setControls] = createSignal<AiDetailControls | null>(null);
export const aiDetailControls = controls;
export const setAiDetailControls = setControls;
