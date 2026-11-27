import { runContextAwareCommand } from "@k2b/cloud/browser/commands";
import { collectContextAwareCommands } from "@k2b/cloud/browser/testing";
import { openCloudMobileMenu } from "@k2b/cloud/ssr/MobileNavigation.tsx";
import { attachWorkspaces } from "@k2b/ui/v2";
import { mount } from "../../../../../../ssr/src/mount";
import BookCharts from "./BookCharts";
import BookController from "./BookController";
import BookHead from "./BookHead";
import BookMermaid from "./BookMermaid";
import BookSidebar from "./BookSidebar";

declare global {
  interface Window {
    /** The page is live: every island has mounted and the workspace is attached. */
    bookReady?: boolean;
    /** Opens the phone's shell menu, as its title row does. */
    openShellMenu?: () => void;
    /** The words of Cloud's search command that hides or shows the navigation, or null without one. */
    navigationCommandTitle?: () => string | null;
    runNavigationCommand?: () => Promise<void>;
  }
}

// Book as a Cloud page brings it alive: the server's markup is there, each island renders again over its own wrapper
// (`@k2b/ssr` mount), and the frame entry attaches the workspace and keeps a hidden sidebar in a cookie.
const island = (name: string) => `solid-island[data-file="${name}.island.tsx"]`;
mount(BookSidebar, island("BookSidebar"));
mount(BookHead, island("BookHead"));
mount(BookController, island("BookController"));
mount(BookMermaid, island("BookMermaid"));
mount(BookCharts, island("BookCharts"));
attachWorkspaces({
  onSidebarCollapsedChange: (collapsed) => {
    document.cookie = `book-sidebar=${collapsed ? "hidden" : "shown"}; path=/`;
  },
});
// the phone's shell menu, as its title row opens it: it shows the navigation the page's sidebar provides
window.openShellMenu = () => void openCloudMobileMenu({ apps: [], legalLinks: [] });
// Cloud's search command that hides or shows the navigation: its words, and running it
const navigationCommand = () => collectContextAwareCommands().find((command) => command.id === "notebooks.navigation.toggle");
window.navigationCommandTitle = () => navigationCommand()?.title ?? null;
window.runNavigationCommand = async () => {
  const command = navigationCommand();
  if (!command) throw new Error("The navigation command is not registered.");
  await runContextAwareCommand(command);
};
// mount renders every wrapper that is there at once, so the page is live from here
window.bookReady = true;
