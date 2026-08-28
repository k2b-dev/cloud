import { i18n } from "@k2b/stdlib";
import { prompts } from "@k2b/ui";
import type { CreateAttachmentLinkInput } from "../../contracts";

export const attachmentLinkPromptMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Share attachment",
      confirm: "Create link",
      info: "Anyone with the link can download this attachment until you revoke it or a limit is reached.",
      expires: "Expires",
      expiresDescription: "Optional. Leave empty for no expiry.",
      password: "Password",
      passwordDescription: "Optional, at least 8 characters. Share it separately from the link.",
      maximumDownloads: "Maximum downloads",
      maximumDownloadsDescription: "Optional. Leave empty for no download limit.",
    },
    de: {
      title: "Anhang freigeben",
      confirm: "Link erstellen",
      info: "Jede Person mit dem Link kann diesen Anhang herunterladen, bis du den Link widerrufst oder ein Limit erreicht ist.",
      expires: "Gültig bis",
      expiresDescription: "Optional. Leer lassen, wenn der Link nicht ablaufen soll.",
      password: "Passwort",
      passwordDescription: "Optional, mindestens 8 Zeichen. Teile es getrennt vom Link.",
      maximumDownloads: "Maximale Downloads",
      maximumDownloadsDescription: "Optional. Leer lassen, wenn es kein Downloadlimit geben soll.",
    },
  },
});

export const attachmentLinkPromptConfig = (locale?: string) => {
  const messages = attachmentLinkPromptMessages.resolve(locale ? [locale] : []).t;
  return {
    title: messages.title,
    icon: "ti ti-link",
    confirmText: messages.confirm,
    fields: {
      info: {
        type: "info",
        content: messages.info,
      },
      expiresAt: { type: "datetime", label: messages.expires, description: messages.expiresDescription },
      password: {
        type: "text",
        label: messages.password,
        description: messages.passwordDescription,
        password: true,
        minLength: 8,
      },
      maxDownloads: {
        type: "number",
        label: messages.maximumDownloads,
        description: messages.maximumDownloadsDescription,
        min: 1,
        max: 1_000_000,
      },
    },
  } as const;
};

export const promptAttachmentLinkOptions = async (locale?: string): Promise<CreateAttachmentLinkInput | null> => {
  const values = await prompts.form(attachmentLinkPromptConfig(locale));
  if (!values) return null;
  return {
    expiresAt: values.expiresAt || null,
    password: values.password || null,
    maxDownloads: values.maxDownloads ?? null,
  };
};
