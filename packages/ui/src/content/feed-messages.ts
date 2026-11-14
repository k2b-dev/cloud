import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const feedMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      feedJumpToLatest: "Jump to latest",
      feedJumpToLatestCount: ({ count }: { count: number }) => `Jump to latest, ${count} new`,
      feedNewItems: ({ count }: { count: number }) => (count === 1 ? "1 new item" : `${count} new items`),
      feedNewMarker: "New",
      feedNewAbove: "New above",
      feedNewAboveCount: ({ count }: { count: number }) => `New above, ${count} new`,
      feedNewAboveItems: ({ count }: { count: number }) => (count === 1 ? "1 new item above" : `${count} new items above`),
      loadMore: "Load more",
      loadingMore: "Loading more…",
      loadMoreFailed: "Could not load more.",
    },
    de: {
      feedJumpToLatest: "Zum Neuesten",
      feedJumpToLatestCount: ({ count }) => `Zum Neuesten, ${count} neu`,
      feedNewItems: ({ count }) => (count === 1 ? "1 neuer Eintrag" : `${count} neue Einträge`),
      feedNewMarker: "Neu",
      feedNewAbove: "Neue oben",
      feedNewAboveCount: ({ count }) => `Neue oben, ${count} neu`,
      feedNewAboveItems: ({ count }) => (count === 1 ? "1 neuer Eintrag oben" : `${count} neue Einträge oben`),
      loadMore: "Mehr laden",
      loadingMore: "Lädt mehr …",
      loadMoreFailed: "Konnte nicht mehr laden.",
    },
  },
});

export type FeedMessages = ReturnType<(typeof feedMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useFeedMessages = (): (() => FeedMessages) => {
  const locale = useLocale();
  return () => feedMessages.resolve([locale()]).t;
};

export const checkFeedMessages = () => feedMessages.check();
