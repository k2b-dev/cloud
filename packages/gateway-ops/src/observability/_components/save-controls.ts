import type { SaveStatusState } from "@k2b/ui";
import { createSignal } from "solid-js";

/**
 * The save status sits in the level head, outside the form island, so both read one store: the form registers its
 * state and actions, the head island renders them. Both are modules of one page bundle (as in the AI area).
 */
export type AreaSaveControls = {
  state: SaveStatusState;
  savedAt?: string;
  invalidCount?: number;
  /** Save stays disabled, for example until the person confirms replacing an unreadable value. */
  saveDisabled?: boolean;
  save: () => void;
  discard: () => void;
};

const [controls, setControls] = createSignal<AreaSaveControls | null>(null);
export const areaSaveControls = controls;
export const setAreaSaveControls = setControls;
