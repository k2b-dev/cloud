import { navigateTo } from "@k2b/ssr/nav";
import { buildPulseWorkspaceHref, type WorkspaceHrefOptions } from "./routes";

export const navigatePulseWorkspace = (options: WorkspaceHrefOptions): void => {
  const href = buildPulseWorkspaceHref(options);
  if (typeof window !== "undefined" && href === `${window.location.pathname}${window.location.search}`) return;
  navigateTo(href);
};
