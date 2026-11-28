import { AppLaunchpadButton, AppLaunchpadProvider } from "../app-launchpad";
import { LayoutHelpPage } from "../LayoutHelp";
import { LayoutHelpDocuments } from "../layout-help-registry";

/** The Layout parts an island renders: in a module of its own, so the islands barrel only re-exports (index.ts). */
export const Layout = {
  HelpDocuments: LayoutHelpDocuments,
  HelpPage: LayoutHelpPage,
  AppLaunchpadButton,
  AppLaunchpadProvider,
};
