import { createContext, useContext } from "solid-js";

/**
 * What the page inside `Layout` renders that the shell around it styles for. The page fills it while the server
 * renders it, and `Layout` writes it onto `.layout-shell-content`, which a page swap replaces together with the page.
 * The shell's style reads these attributes instead of asking the whole shell through `:has()`, which in Chromium
 * restyles the whole page on every change inside it.
 */
export type ShellContentState = { workspaceNavigation: boolean; ownTitle: boolean };

export const ShellContentStateContext = createContext<ShellContentState>();

/** Marks the page for the shell; only the server render of a page inside `Layout` records it. */
export const markShellContent = (key: keyof ShellContentState): void => {
  const state = useContext(ShellContentStateContext);
  if (state) state[key] = true;
};
