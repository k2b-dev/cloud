export { default as PageTrail, type PageTrailProps } from "../PageTrail";
export { default as WorkspaceNavigationProvider } from "../WorkspaceNavigationProvider";
export { provideWorkspaceNavigation } from "../workspace-navigation";
export { default as SearchBar } from "./SearchBar";

import { AppLaunchpadButton, AppLaunchpadProvider } from "../app-launchpad";
import { LayoutHelpPage } from "../LayoutHelp";
import { LayoutHelpDocuments } from "../layout-help-registry";

export type { AppLaunchpadApp, AppLaunchpadLegalLink } from "../app-launchpad";
export { AppLaunchpadButton, AppLaunchpadProvider, openAppLaunchpad, setAppLaunchpadContext } from "../app-launchpad";
export type { LayoutHelpPageProps } from "../LayoutHelp";
export { LayoutHelpPage, openLayoutHelpDialog } from "../LayoutHelp";
export type { LayoutHelpDocumentsProps } from "../layout-help-registry";
export { LayoutHelpDocuments } from "../layout-help-registry";

export const Layout = {
  HelpDocuments: LayoutHelpDocuments,
  HelpPage: LayoutHelpPage,
  AppLaunchpadButton,
  AppLaunchpadProvider,
};
