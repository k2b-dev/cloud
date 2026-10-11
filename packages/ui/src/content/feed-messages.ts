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
    },
    de: {
      feedJumpToLatest: "Zum Neuesten",
      feedJumpToLatestCount: ({ count }) => `Zum Neuesten, ${count} neu`,
      feedNewItems: ({ count }) => (count === 1 ? "1 neuer Eintrag" : `${count} neue Einträge`),
      feedNewMarker: "Neu",
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
