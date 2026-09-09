export { default as SearchBar } from "./SearchBar.island";

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
