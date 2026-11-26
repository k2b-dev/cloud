import { attachWorkspaces } from "@k2b/ui/v2";
import { openCloudMobileMenu } from "../../../../../../cloud/src/ssr/MobileNavigation";
import { mount } from "../../../../../../ssr/src/mount";
import BookCharts from "./BookCharts";
import BookController from "./BookController";
import BookHead from "./BookHead";
import BookMermaid from "./BookMermaid";
import BookSidebar from "./BookSidebar";

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
(window as Window & { openShellMenu?: () => void }).openShellMenu = () => void openCloudMobileMenu({ apps: [], legalLinks: [] });
// mount renders every wrapper that is there at once, so the page is live from here
(window as Window & { bookReady?: boolean }).bookReady = true;
