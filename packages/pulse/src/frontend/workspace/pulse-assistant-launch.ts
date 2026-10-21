import { type AssistantLaunch, launchAssistant } from "@k2b/cloud/ai/browser";
import { pulseMessages } from "../../messages";
import { pulseBaseHref } from "../../resource-hrefs";
import type { SqlParams } from "./sql-client";

export type PulseAssistantLaunchInput = {
  base: { id: string; name: string };
  sql: string;
  params: SqlParams;
  queryName?: string;
  /** Supply the inherited/request locale; the standalone fallback follows Mail's document locale. */
  locale?: string;
};
export const launchPulseSqlAssistant = (input: PulseAssistantLaunchInput): Promise<AssistantLaunch> => {
  const locale = input.locale ?? (typeof document === "undefined" ? "en" : document.documentElement.lang);
  const t = pulseMessages.resolve([locale]).t;
  const title = input.sql.trim() && input.queryName?.trim() ? input.queryName.trim() : t.sqlNewQuery;
  // A longer fence keeps SQL containing backticks inside the draft's SQL block.
  const fence = "`".repeat(Math.max(3, ...[...input.sql.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  const prompt = input.sql.trim() ? t.sqlAssistantPrompt : t.sqlAssistantEmptyPrompt({ base: input.base.name });
  const text = `${prompt}\n\n${fence}sql\n${input.sql}\n${fence}${Object.entries(input.params)
    .map(([name, value]) => `\n${name} = ${value}`)
    .join("")}`;
  return launchAssistant({
    launchedByAppId: "pulse",
    title: `${title} · ${input.base.name}`,
    skills: ["cloud-pulse"],
    preloadTools: [
      { appId: "pulse", kind: "query", id: "sql.run" },
      { appId: "pulse", kind: "query", id: "base.read" },
      { appId: "pulse", kind: "query", id: "source.list" },
    ],
    draft: {
      content: [
        { type: "text", text },
        {
          type: "resource",
          ref: { type: "pulse.base", id: input.base.id },
          title: input.base.name,
          icon: "ti ti-activity-heartbeat",
          href: pulseBaseHref(input.base.id),
        },
      ],
    },
  });
};
