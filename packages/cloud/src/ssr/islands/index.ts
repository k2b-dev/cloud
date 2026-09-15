export { default as SearchBar } from "./SearchBar";
export { provideWorkspaceNavigation } from "../workspace-navigation";
export { default as WorkspaceNavigationProvider } from "../WorkspaceNavigationProvider";

import { AppLaunchpadButton, AppLaunchpadProvider } from "../AppLaunchpad.island";
import { LayoutHelpDocuments, LayoutHelpPage } from "../LayoutHelp";

export type { AppLaunchpadApp, AppLaunchpadLegalLink } from "../AppLaunchpad.island";
export { AppLaunchpadButton, AppLaunchpadProvider, openAppLaunchpad, setAppLaunchpadContext } from "../AppLaunchpad.island";
export type { LayoutHelpDocumentsProps, LayoutHelpPageProps } from "../LayoutHelp";
export { LayoutHelpDocuments, LayoutHelpPage, openLayoutHelpDialog } from "../LayoutHelp";

export const Layout = {
  HelpDocuments: LayoutHelpDocuments,
  HelpPage: LayoutHelpPage,
  AppLaunchpadButton,
  AppLaunchpadProvider,
};
