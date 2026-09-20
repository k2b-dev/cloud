import { getCapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import type { AiChatTaskView } from "@k2b/cloud/ai";

// Presentation only: enforcement continues to use the exact stored grants.
export async function taskGrantPresentation(grants: AiChatTaskView["grants"], locale = "en") {
  const de = locale.startsWith("de");
  const apps = new Map(
    await Promise.all(
      [...new Set(grants.map((grant) => grant.appId))].map(async (id) => [id, await getCapabilityCatalogApp(id, locale)] as const),
    ),
  );
  return grants.map((grant) => {
    const result = apps.get(grant.appId);
    const app = result?.ok ? result.data : null;
    const operation = (grant.kind === "query" ? app?.manifest.queries : app?.manifest.actions)?.find(
      (item) => item.localId === grant.capabilityId,
    );
    const fields = Object.entries(grant.fixedInput).map(([key, value]) => {
      const schema: unknown = Object.entries(operation?.inputSchema.properties ?? {}).find(([name]) => name === key)?.[1];
      const label =
        schema && typeof schema === "object" && "title" in schema && typeof schema.title === "string"
          ? schema.title
          : schema && typeof schema === "object" && "description" in schema && typeof schema.description === "string"
            ? schema.description.split(/[.\n]/u)[0]!.slice(0, 120)
            : key;
      return `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
    });
    return {
      title: operation?.title ?? grant.capabilityId,
      app: app?.appName ?? grant.appId,
      icon: app?.appIcon ?? "ti ti-key",
      mode: grant.kind === "query" ? (de ? "Nur lesen" : "Read only") : de ? "Aktion ausführen" : "Perform action",
      scope: fields.length
        ? de
          ? `Festgelegt: ${fields.join("; ")}. Andere Eingaben darf die Aufgabe selbst wählen.`
          : `Fixed: ${fields.join("; ")}. The task may choose other inputs itself.`
        : de
          ? "Keine Einschränkung auf bestimmte Inhalte."
          : "Not limited to specific content.",
    };
  });
}

export async function taskGrantReview(grants: AiChatTaskView["grants"], locale = "en") {
  const items = await taskGrantPresentation(grants, locale);
  const escape = (value: string) => value.replace(/[\\`*_{}\[\]()<>#+.!|~-]/gu, "\\$&");
  return {
    label: locale.startsWith("de") ? "Das erlaubst du dieser Aufgabe" : "What you allow this task to do",
    value: items.length
      ? items.map((item) => `**${escape(item.title)}** · ${escape(item.app)}  \n${escape(item.scope).replaceAll("\n", "  \n")}`).join("\n\n")
      : locale.startsWith("de")
        ? "Keine zusätzlichen Zugriffe."
        : "No additional access.",
    display: "block" as const,
    format: "markdown" as const,
  };
}
