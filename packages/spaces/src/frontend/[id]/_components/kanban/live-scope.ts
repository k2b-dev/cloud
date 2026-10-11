type LoadedPage = { items: readonly { id: string }[]; page: number; totalPages: number; total: number; unfilteredTotal?: number };

/**
 * A column skips a change only when it provably neither held nor holds the item: all of its items are
 * loaded and shown, none is the item, and the server probe does not find it there now. Membership stays
 * server-owned; a failed probe conservatively reloads its column.
 */
export const shouldReloadKanbanColumn = (params: { itemId: string | null; pages: readonly LoadedPage[]; probe: boolean | null }) => {
  const first = params.pages[0];
  const last = params.pages.at(-1);
  const complete =
    first !== undefined && last !== undefined && last.page >= last.totalPages && (first.unfilteredTotal ?? first.total) === first.total;
  return (
    params.itemId === null ||
    params.probe !== false ||
    !complete ||
    params.pages.some((page) => page.items.some((item) => item.id === params.itemId))
  );
};
