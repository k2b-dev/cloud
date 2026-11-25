import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";

/** The words of the request list on v2 that the shared catalogs do not have. */
export const requestMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      optional: "optional",
      createFor: ({ name }: { name: string }) => `Create an account for ${name}`,
      denyFor: ({ name }: { name: string }) => `Deny the request from ${name}`,
    },
    de: {
      optional: "optional",
      createFor: ({ name }) => `Konto für ${name} anlegen`,
      denyFor: ({ name }) => `Anfrage von ${name} ablehnen`,
    },
  },
});

export const useRequestMessages = () => {
  const locale = useLocale();
  return createMemo(() => requestMessages.resolve([locale()]).t);
};
