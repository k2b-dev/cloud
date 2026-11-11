import { i18n } from "@k2b/stdlib";
import type { CodePolicyValue } from "../../code/policy-contracts";

/** Words around the generated Code reference in an app's Help. Paths and descriptions come from the app's manifest. */
export const codeHelpMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Use in Code",
      lead: ({ app }: { app: string }) => `What your Code can do in ${app}. The label shows when a call runs in your own Code.`,
      operations: ({ count }: { count: number }) => `Operations (${count})`,
      events: ({ count }: { count: number }) => `Events (${count})`,
      policy: ({ value }: { value: CodePolicyValue }) =>
        ({ automatic: "Automatic", admin: "Administrator approves", never: "Never" })[value],
      policyHint: ({ value }: { value: CodePolicyValue }) =>
        ({
          automatic: "This call runs without a question.",
          admin: "A Cloud administrator must approve the version before this call runs.",
          never: "Your Code cannot make this call.",
        })[value],
      subject: "Subject",
      place: "Place",
      noPlace: "No place",
      empty: ({ app }: { app: string }) => `${app} has no operations for Code.`,
      failed: "The Code reference did not load.",
      reload: "Reload",
    },
    de: {
      title: "In Code nutzen",
      lead: ({ app }: { app: string }) =>
        `Was dein Code in ${app} tun kann. Die Markierung zeigt, wann ein Aufruf in deinem eigenen Code läuft.`,
      operations: ({ count }: { count: number }) => `Operationen (${count})`,
      events: ({ count }: { count: number }) => `Ereignisse (${count})`,
      policy: ({ value }: { value: CodePolicyValue }) =>
        ({ automatic: "Automatisch", admin: "Administration gibt frei", never: "Nie" })[value],
      policyHint: ({ value }: { value: CodePolicyValue }) =>
        ({
          automatic: "Dieser Aufruf läuft ohne Rückfrage.",
          admin: "Die Administration muss die Version freigeben, bevor dieser Aufruf läuft.",
          never: "Dein Code kann diesen Aufruf nicht machen.",
        })[value],
      subject: "Gegenstand",
      place: "Ort",
      noPlace: "Kein Ort",
      empty: ({ app }: { app: string }) => `${app} bietet Code keine Operationen an.`,
      failed: "Die Code-Referenz wurde nicht geladen.",
      reload: "Neu laden",
    },
  },
});
