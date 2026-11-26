import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";

/** A count as the locale writes it: "1.284", "1,284". */
const number = (count: number, locale: string) => new Intl.NumberFormat(locale).format(count);

/** The words of the agent list and an agent's page with its API keys. */
export const agentMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      agents: "Agents",
      agentsCount: ({ count }: { count: number }) => i18n.plural(count, "en", { one: "1 agent", other: `${number(count, "en")} agents` }),
      noAgents: "No agents yet. Create one with cld admin agents create.",
      agent: "Agent",
      active: "Active",
      disabled: "Disabled",
      name: "Name",
      status: "Status",
      created: "Created",
      createdBy: "Created by",
      previous: "Previous",
      next: "Next",
      pageOf: ({ page, pages }: { page: number; pages: number }) => `Page ${page} of ${pages}`,
      details: "Details",
      keys: "API keys",
      keysFailed: "The API keys could not be loaded. The keys themselves are unchanged.",
      retry: "Try again",
      fullAccess: "Full access",
      modelsOnly: "AI models only",
      legacyLimited: "Older key, limited",
      close: "Close",
      agentDisabledNotice: "This agent is disabled. Its keys stop working, and it gets no new key until it is enabled again.",
      reachTitle: "What an API key reaches",
      reachFull: "Every REST API and cld command, as far as the agent's rights reach.",
      reachModels: "Only the AI models the agent may use. No Cloud tools.",
      reachLegacy: "Only the scopes set when the key was created.",
      reachWhileActive: "A key works only while the agent is active. Once the agent is disabled, none of its keys works.",
      createdOn: ({ when }: { when: string }) => `created ${when}`,
    },
    de: {
      agents: "Agenten",
      agentsCount: ({ count }) => i18n.plural(count, "de", { one: "1 Agent", other: `${number(count, "de")} Agenten` }),
      noAgents: "Noch keine Agenten. Lege einen mit cld admin agents create an.",
      agent: "Agent",
      active: "Aktiv",
      disabled: "Deaktiviert",
      name: "Name",
      status: "Status",
      created: "Angelegt",
      createdBy: "Angelegt von",
      previous: "Zurück",
      next: "Weiter",
      pageOf: ({ page, pages }) => `Seite ${page} von ${pages}`,
      details: "Angaben",
      keys: "API Keys",
      keysFailed: "Die API Keys konnten nicht geladen werden. Die Keys selbst bleiben unverändert.",
      retry: "Erneut versuchen",
      fullAccess: "Vollzugriff",
      modelsOnly: "Nur KI-Modelle",
      legacyLimited: "Älterer Key, begrenzt",
      close: "Schließen",
      agentDisabledNotice:
        "Dieser Agent ist deaktiviert. Seine Keys funktionieren nicht, und er bekommt erst nach dem Aktivieren einen neuen.",
      reachTitle: "Was ein API Key erreicht",
      reachFull: "Jede REST-API und jeden cld-Befehl, soweit die Rechte des Agenten reichen.",
      reachModels: "Nur die KI-Modelle, die der Agent nutzen darf. Keine Cloud-Werkzeuge.",
      reachLegacy: "Nur die Bereiche, die beim Anlegen gesetzt wurden.",
      reachWhileActive: "Ein Key gilt nur, solange der Agent aktiv ist. Wird der Agent deaktiviert, wirkt keiner seiner Keys mehr.",
      createdOn: ({ when }) => `angelegt ${when}`,
    },
  },
});

export type AgentMessages = ReturnType<typeof agentMessages.resolve>["t"];

export const useAgentMessages = () => {
  const locale = useLocale();
  return createMemo(() => agentMessages.resolve([locale()]).t);
};
