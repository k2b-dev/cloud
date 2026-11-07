import type { LayoutBreadcrumb } from "@k2b/cloud/ssr/layout-runtime";

/**
 * The title array Chat gives the shell, the same on the server and after in-page navigation. A page below the list
 * leads up to the list as it was left (archive, Unread). For You and the channel directory have their own
 * "Back to chats", so the shell adds no way up beside it.
 */
export const chatTitle = (options: {
  start: string;
  appName: string;
  title?: string;
  listHref: string;
  ownBack: boolean;
}): LayoutBreadcrumb[] => [
  { title: options.start, href: "/" },
  options.title && !options.ownBack ? { title: options.appName, href: options.listHref } : { title: options.appName },
  ...(options.title ? [{ title: options.title }] : []),
];
