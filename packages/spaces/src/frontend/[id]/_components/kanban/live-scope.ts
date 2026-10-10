/** Membership stays server-owned; a failed probe conservatively reloads its column. */
export const shouldReloadKanbanColumn = (params: {
  itemId: string | null;
  pages: readonly { items: readonly { id: string }[] }[];
  probe: boolean | null;
}) => params.itemId === null || params.pages.some((page) => page.items.some((item) => item.id === params.itemId)) || params.probe !== false;
