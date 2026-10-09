import { i18n } from "@k2b/stdlib";
import { useLocale } from "../../intl/locale";

/** The picker's own strings. They live with the picker, so pages without it do not carry them. */
const emojiMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      emojiPicker: "Emoji",
      emojiSearch: "Search emoji",
      emojiGroups: "Emoji groups",
      emojiRecent: "Recently used",
      emojiSmileys: "Smileys & emotion",
      emojiPeople: "People & body",
      emojiAnimals: "Animals & nature",
      emojiFood: "Food & drink",
      emojiTravel: "Travel & places",
      emojiActivities: "Activities",
      emojiObjects: "Objects",
      emojiSymbols: "Symbols",
      emojiFlags: "Flags",
      emojiSkinTone: "Skin tone",
      emojiToneDefault: "Default",
      emojiToneLight: "Light",
      emojiToneMediumLight: "Medium-light",
      emojiToneMedium: "Medium",
      emojiToneMediumDark: "Medium-dark",
      emojiToneDark: "Dark",
      emojiNoResults: "No emoji found",
      emojiLoadFailed: "Emoji could not be loaded.",
    },
    de: {
      emojiPicker: "Emoji",
      emojiSearch: "Emoji suchen",
      emojiGroups: "Emoji-Gruppen",
      emojiRecent: "Zuletzt verwendet",
      emojiSmileys: "Smileys & Emotionen",
      emojiPeople: "Menschen & Körper",
      emojiAnimals: "Tiere & Natur",
      emojiFood: "Essen & Trinken",
      emojiTravel: "Reisen & Orte",
      emojiActivities: "Aktivitäten",
      emojiObjects: "Gegenstände",
      emojiSymbols: "Symbole",
      emojiFlags: "Flaggen",
      emojiSkinTone: "Hautfarbe",
      emojiToneDefault: "Standard",
      emojiToneLight: "Hell",
      emojiToneMediumLight: "Mittelhell",
      emojiToneMedium: "Mittel",
      emojiToneMediumDark: "Mitteldunkel",
      emojiToneDark: "Dunkel",
      emojiNoResults: "Kein Emoji gefunden",
      emojiLoadFailed: "Emoji konnten nicht geladen werden.",
    },
  },
});

export type EmojiMessages = ReturnType<(typeof emojiMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale, like the rest of @k2b/ui. */
export const useEmojiMessages = (): (() => EmojiMessages) => {
  const locale = useLocale();
  return () => emojiMessages.resolve([locale()]).t;
};

export const checkEmojiMessages = () => emojiMessages.check();
