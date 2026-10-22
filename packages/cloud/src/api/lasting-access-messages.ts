import { i18n } from "@k2b/stdlib";

export const lastingAccessApiMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      browserSignInRequired: "Create API keys and passkeys in the browser.",
      reauthenticate: "Sign in again to confirm it is you.",
      forbidden: "This account cannot create new access.",
    },
    de: {
      browserSignInRequired: "API-Schlüssel und Passkeys legst du im Browser an.",
      reauthenticate: "Melde dich erneut an, um zu bestätigen, dass du es bist.",
      forbidden: "Dieses Konto kann keinen neuen Zugang anlegen.",
    },
  },
});
