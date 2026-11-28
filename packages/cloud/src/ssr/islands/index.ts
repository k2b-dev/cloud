export { type AdminWorkspaceProps, default as AdminWorkspace } from "../AdminWorkspace";
export type { AppLaunchpadApp, AppLaunchpadLegalLink } from "../app-launchpad";
export { AppLaunchpadButton, AppLaunchpadProvider, openAppLaunchpad, setAppLaunchpadContext } from "../app-launchpad";
export type { LayoutHelpPageProps } from "../LayoutHelp";
export { LayoutHelpPage, openLayoutHelpDialog } from "../LayoutHelp";
export type { LayoutHelpDocumentsProps } from "../layout-help-registry";
export { LayoutHelpDocuments } from "../layout-help-registry";
export { default as PageTrail, type PageTrailProps } from "../PageTrail";
export { default as V2WorkspaceNavigation, type V2WorkspaceNavigationProps } from "../V2WorkspaceNavigation";
export { default as WorkspaceNavigationProvider } from "../WorkspaceNavigationProvider";
export { provideWorkspaceNavigation } from "../workspace-navigation";
// The barrel only re-exports: a module with code of its own would carry what any island takes from it into every
// island that imports the barrel (barrel.bundle.test.ts).
export { Layout } from "./layout";
export { default as SearchBar } from "./SearchBar";
