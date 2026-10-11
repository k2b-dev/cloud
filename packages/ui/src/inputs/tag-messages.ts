import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const tagMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      addTag: "Add tag",
      noTagsYet: "No tags yet",
      removeTag: "Remove tag",
      tagName: "Tag name",
      tagCouldNotBeSaved: "The tag could not be saved.",
      tagActionFailed: "The tag action failed.",
      tagsPlaceholder: "Tags (e.g. Tag 1, Tag 2,...)",
      tagsAdded: ({ tags }: { tags: string }) => `Tags added: ${tags}.`,
      tagsRemoved: ({ tags }: { tags: string }) => `Tags removed: ${tags}.`,
    },
    de: {
      addTag: "Tag hinzufügen",
      noTagsYet: "Noch keine Tags",
      removeTag: "Tag entfernen",
      tagName: "Tag-Name",
      tagCouldNotBeSaved: "Der Tag konnte nicht gespeichert werden.",
      tagActionFailed: "Die Tag-Aktion ist fehlgeschlagen.",
      tagsPlaceholder: "Tags (z. B. Tag 1, Tag 2, …)",
      tagsAdded: ({ tags }) => `Tags hinzugefügt: ${tags}.`,
      tagsRemoved: ({ tags }) => `Tags entfernt: ${tags}.`,
    },
  },
});

export type TagMessages = ReturnType<(typeof tagMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useTagMessages = (): (() => TagMessages) => {
  const locale = useLocale();
  return () => tagMessages.resolve([locale()]).t;
};

export const checkTagMessages = () => tagMessages.check();
