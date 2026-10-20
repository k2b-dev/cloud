import { getContext } from "../browser/panel";
import { panelShortcutsReceived, readPanelShortcuts } from "../browser/panel-shortcuts";
import type { HelpShortcutCommand } from "./layout-help-start";

/** An empty host list is authoritative too, including when a reader remounts. */
export const readHelpPanelShortcuts = (seed: HelpShortcutCommand[]): HelpShortcutCommand[] =>
  panelShortcutsReceived() && getContext() !== null ? readPanelShortcuts() : seed;
