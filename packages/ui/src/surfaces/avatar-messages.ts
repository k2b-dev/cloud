import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const avatarMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      avatarLabel: ({ name }: { name: string }) => `${name} avatar`,
      unknownUser: "Unknown user",
    },
    de: {
      avatarLabel: ({ name }) => `Avatar von ${name}`,
      unknownUser: "Unbekannte Person",
    },
  },
});

export type AvatarMessages = ReturnType<(typeof avatarMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useAvatarMessages = (): (() => AvatarMessages) => {
  const locale = useLocale();
  return () => avatarMessages.resolve([locale()]).t;
};

export const checkAvatarMessages = () => avatarMessages.check();
