import type { Completion } from "@codemirror/autocomplete";

export type IconCompletion = Completion & { completionIcon?: string };

/** Attach the icon read by the shared autocomplete option renderer. */
export const withIcon = <C extends Completion>(completion: C, icon: string): C => {
  (completion as IconCompletion).completionIcon = icon;
  return completion;
};
