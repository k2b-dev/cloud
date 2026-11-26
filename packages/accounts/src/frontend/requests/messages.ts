import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";

/** The words of the request list on v2 that the shared catalogs do not have. */
export const requestMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      optional: "optional",
      oldestBefore: "oldest from",
      overdue: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: "1 waits over a week", other: `${count} wait over a week` }),
      emptyPending: "No request is waiting for a decision.",
      createFor: ({ name }: { name: string }) => `Create an account for ${name}`,
      denyFor: ({ name }: { name: string }) => `Deny the request from ${name}`,
      lead: ({ count, status }: { count: number; status: "pending" | "completed" | "denied" | "all" }) => {
        const n = count.toLocaleString("en");
        const kind = status === "all" ? "" : `${status} `;
        return count === 1 ? `1 ${kind}request` : `${n} ${kind}requests`;
      },
    },
    de: {
      optional: "optional",
      oldestBefore: "älteste vom",
      overdue: ({ count }) => i18n.plural(count, "de", { one: "1 wartet über eine Woche", other: `${count} warten über eine Woche` }),
      emptyPending: "Keine Anfrage wartet auf eine Entscheidung.",
      createFor: ({ name }) => `Konto für ${name} anlegen`,
      denyFor: ({ name }) => `Anfrage von ${name} ablehnen`,
      lead: ({ count, status }) => {
        const n = count.toLocaleString("de");
        const one = { pending: "ausstehende", completed: "abgeschlossene", denied: "abgelehnte", all: "" }[status];
        return `${count === 1 ? "1" : n} ${one ? `${one} ` : ""}${count === 1 ? "Anfrage" : "Anfragen"}`;
      },
    },
  },
});

export const useRequestMessages = () => {
  const locale = useLocale();
  return createMemo(() => requestMessages.resolve([locale()]).t);
};
