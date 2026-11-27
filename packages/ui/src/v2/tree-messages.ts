import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/**
 * The words of trees in v2 (the navigation tree and Table's tree rows). They live apart from the shared catalog so a
 * part that imports only a small component never carries them.
 */
const treeMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      loadMore: ({ count }: { count: number | undefined }) =>
        count === undefined ? "Load more" : `Load ${count.toLocaleString("en")} more`,
      loadMoreFailed: "Couldn't load more. Try again",
      deedsHint: "Actions: long press or Shift+F10",
    },
    de: {
      loadMore: ({ count }) => (count === undefined ? "Weitere laden" : `Weitere ${count.toLocaleString("de")} laden`),
      loadMoreFailed: "Weitere konnten nicht geladen werden. Erneut versuchen",
      deedsHint: "Aktionen: lange drücken oder Umschalt+F10",
    },
  },
});

export type TreeMessages = ReturnType<(typeof treeMessages)["resolve"]>["t"];

export const useTreeMessages = (): (() => TreeMessages) => {
  const locale = useLocale();
  return () => treeMessages.resolve([locale()]).t;
};

export const checkTreeMessages = () => treeMessages.check();
