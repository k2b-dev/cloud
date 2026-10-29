import { i18n } from "@k2b/stdlib";
import type { Context } from "hono";
import { getLocale } from "../../server/locale";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      recovery: "Use another sign-in method to confirm your identity. To recover an account, sign out first.",
      mismatch: "Sign in with the account already open in this browser. If your session expired, open the sign-in page and start again.",
    },
    de: {
      recovery: "Bestätige deine Identität mit einer anderen Anmeldemethode. Zur Kontowiederherstellung melde dich zuerst ab.",
      mismatch:
        "Melde dich mit dem Konto an, das in diesem Browser geöffnet ist. Falls deine Sitzung abgelaufen ist, öffne die Anmeldeseite und beginne erneut.",
    },
  },
});

export const accountMismatchResponse = (c: Context) =>
  c.json({ code: "ACCOUNT_MISMATCH", message: messages.resolve([getLocale(c)]).t.mismatch }, 403);

export const confirmationRecoveryResponse = (c: Context) =>
  c.json({ code: "CONFIRMATION_METHOD_UNAVAILABLE", message: messages.resolve([getLocale(c)]).t.recovery }, 403);
