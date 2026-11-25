import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";

/** The words of the deleted-accounts list on v2 that the shared catalogs do not have. */
export const deletedMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      searchLabel: "Name, UID or email",
      newestFirst: "Newest first",
      noMatches: "No deleted account matches these filters.",
      entryGone: "This entry is not on this page any more. Open it again from the list.",
    },
    de: {
      searchLabel: "Name, UID oder E-Mail",
      newestFirst: "Neueste zuerst",
      noMatches: "Kein gelöschtes Konto passt zu diesen Filtern.",
      entryGone: "Dieser Eintrag steht nicht mehr auf dieser Seite. Öffne ihn erneut aus der Liste.",
    },
  },
});

export const useDeletedMessages = () => {
  const locale = useLocale();
  return createMemo(() => deletedMessages.resolve([locale()]).t);
};
