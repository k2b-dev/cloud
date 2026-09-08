import { listenPopState } from "@k2b/ssr/nav";

export const listenForSelectedItem = (select: (itemId: string | null) => void): (() => void) =>
  listenPopState(({ url }) => {
    select(url.searchParams.get("item"));
  });
