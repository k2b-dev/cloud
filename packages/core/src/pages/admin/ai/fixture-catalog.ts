/** Invented catalog for the AI area's browser fixture: Model classes, Providers and Budgets with their API. */
import type { AiModelSlot } from "@k2b/cloud/shared";
import { type AiFixtureCatalog, aiFixtureCatalog, aiFixtureOverview, aiFixtureUsage } from "./AiArea.fixture-data";
import { parseAiAreaQuery } from "./area";
import type { AiBudgetsData, AiClassesData, AiProvidersData } from "./catalog-data";
import type { AiFixtureApi, AiFixtureInput } from "./fixture-types";

/** States the captures and tests switch with `?state=`. */
export type AiCatalogFixtureState =
  | "normal"
  | "worst"
  | "decision"
  | "empty"
  | "unreachable"
  | "badkey"
  | "modeldraft"
  | "detailfail"
  | "detailempty"
  | "listempty"
  | "unassigned"
  | "conflict"
  | "listfail"
  | "saving"
  | "orphan";

const ADMIN = "11111111-1111-4111-8111-111111111111";

/** The worst case: long and unbreakable names, one-letter names, non-Latin text, emoji, extreme numbers, many models. */
const worst = (catalog: AiFixtureCatalog): AiFixtureCatalog => {
  const long = catalog.providers[0]!;
  const providers = [
    {
      ...long,
      label: "Rechenzentrum der Universitätsverwaltung für besonders vertrauliche Forschungsdaten",
      baseUrl: "https://inference-gateway.forschungsdaten.universitaetsverwaltung.example.org/v1/openai-compatible/chat/completions",
    },
    { ...catalog.providers[1]!, id: "x", label: "X", status: "key_rejected" as const, statusCode: "401" },
    { ...catalog.providers[2]!, id: "kanji", label: "東京リサーチ計算センター", dataBoundary: "restricted" as const },
    { ...catalog.providers[3]!, id: "emoji", label: "🚀 Rakete", enabled: false },
    ...catalog.providers.slice(4),
  ];
  // a provider list that keeps growing (OpenRouter offers hundreds): 1,000 models on the first provider
  const many = Array.from({ length: 1000 }, (_, index) => ({
    ...catalog.models[0]!,
    id: `bulk-${index}`,
    label: index % 7 === 0 ? "Sehr langer Modellname mit vielen Wörtern und einer Versionsnummer 2026-11-27-preview" : `Modell ${index}`,
    providerModel: `vendor/organisation-with-a-very-long-name/model-${index}-instruct-awq-int4-preview`,
    pricing: index % 5 === 0 ? null : { inputPerMillion: 123_456.789, outputPerMillion: 0.000_001 },
    enabled: index % 4 !== 0,
  }));
  return {
    ...catalog,
    providers,
    models: [...catalog.models, ...many],
    variants: [...catalog.variants, ...many.map((model) => ({ ...catalog.variants[0]!, id: model.id, modelId: model.id }))],
  };
};

export const catalogFor = (state: string): AiFixtureCatalog => {
  const catalog = aiFixtureCatalog();
  if (state === "empty")
    return {
      providers: [],
      models: [],
      variants: [],
      assignments: {
        fast: null,
        balanced: null,
        thorough: null,
        maximum: null,
        vision: null,
        audio: null,
        liveAudio: null,
        decision: null,
      },
    };
  if (state === "worst") return worst(catalog);
  if (state === "decision") {
    catalog.models.push({
      ...catalog.models[0]!,
      id: "clef",
      label: "Clef decision",
      providerModel: "cloudflare/clef",
      kind: "decision",
      capabilities: ["vision"],
      maxOutputTokens: null,
    });
    catalog.variants.push({
      ...catalog.variants[0]!,
      id: "clef",
      modelId: "clef",
      slug: "standard",
      label: "Standard",
      reasoningEffort: null,
    });
  }
  const cortecs = catalog.providers.find((entry) => entry.id === "cortecs")!;
  if (state === "unreachable") Object.assign(cortecs, { status: "unreachable", statusMessage: "Keine Antwort nach 10 s." });
  if (state === "badkey") Object.assign(cortecs, { status: "key_rejected", statusCode: "401" });
  if (state === "unassigned") catalog.assignments.maximum = null;
  return catalog;
};

const indexOf = (catalog: AiFixtureCatalog) => {
  const overview = aiFixtureOverview(catalog);
  return { overview, index: { models: catalog.models, variants: catalog.variants, assignments: overview.assignments } };
};

export const classesFixture = (input: AiFixtureInput): AiClassesData => {
  const catalog = catalogFor(input.state);
  const { overview, index } = indexOf(catalog);
  const query = parseAiAreaQuery(Object.fromEntries(input.params));
  const slot = query.slot ?? null;
  return {
    overview,
    models: index.models,
    variants: index.variants,
    slot,
    assignment: slot
      ? {
          slot,
          variantId: catalog.assignments[slot],
          revision: 2,
          updatedAt: "2026-10-27T16:32:00.000Z",
          updatedBy: ADMIN,
          fallbackChain: [],
          effectiveClass: null,
          usage:
            slot === "fast"
              ? [
                  { class: "fast", app: "core", task: "Chat-Titel", calls: 1840 },
                  { class: "fast", app: "mail", task: "Betreff", calls: 312 },
                ]
              : slot === "balanced"
                ? [{ class: "balanced", app: "workflows", task: "KI-Schritt", calls: 96 }]
                : [],
        }
      : null,
    detailFailed: input.state === "detailfail",
  };
};

export const providersFixture = (input: AiFixtureInput): AiProvidersData => {
  const catalog = catalogFor(input.state);
  const { overview, index } = indexOf(catalog);
  const query = parseAiAreaQuery(Object.fromEntries(input.params));
  const row = catalog.providers.find((entry) => entry.id === query.p);
  const provider = row ? { ...row, models: catalog.models.filter((entry) => entry.providerId === row.id) } : null;
  const modelRow = query.m ? catalog.models.find((entry) => entry.id === query.m) : undefined;
  const model = modelRow
    ? {
        ...modelRow,
        icon: input.state === "modeldraft" ? { kind: "emoji" as const, emoji: "🌿" } : modelRow.icon,
        variants: catalog.variants.filter((entry) => entry.modelId === modelRow.id),
        access: {
          entries: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              principal:
                input.state === "modeldraft"
                  ? { type: "user" as const, userId: "33333333-3333-4333-8333-333333333333" }
                  : { type: "authenticated" as const },
              displayName: input.state === "modeldraft" ? "Jona Beispiel" : undefined,
              permission: "read" as const,
              createdAt: "2026-10-02T09:00:00.000Z",
            },
          ],
          revision: 1,
        },
      }
    : null;
  const failed = input.state === "detailfail";
  return {
    overview,
    models: index.models,
    variants: index.variants,
    open: { p: query.p ?? null, m: query.m ?? null, connection: query.pane === "conn", dialog: query.o ?? null },
    provider: failed ? null : provider,
    model: failed || input.state === "detailempty" ? null : model,
    usage: model ? aiFixtureUsage(model.id) : null,
    accountingUnit: "EUR",
    detailFailed: failed,
  };
};

export const budgetsFixture = (input: AiFixtureInput): AiBudgetsData => {
  const catalog = catalogFor(input.state);
  const worstCase = input.state === "worst";
  return {
    config: {
      enabled: true,
      revision: 4,
      unit: "EUR",
      background: { enabled: true, warnAt: 40, stopAt: 60 },
      rules:
        input.state === "empty"
          ? []
          : [
              {
                scope: "*",
                hours: 168,
                anchor: "2026-10-26T00:00:00.000Z",
                grants: [{ principal: { type: "authenticated" as const }, limit: 10 }],
                peopleAtLimit: worstCase ? 12_345 : 0,
              },
              {
                scope: "claude",
                hours: 168,
                anchor: "2026-10-26T00:00:00.000Z",
                grants: [
                  {
                    principal: { type: "group" as const, groupId: "33333333-3333-4333-8333-333333333333" },
                    displayName: worstCase
                      ? "Arbeitsgruppe für maschinelles Lernen und angewandte Sprachverarbeitung"
                      : "Gruppe Entwicklung",
                    limit: worstCase ? 999_999.99 : 30,
                  },
                  ...(worstCase
                    ? [
                        {
                          principal: { type: "user" as const, userId: "55555555-5555-4555-8555-555555555555" },
                          displayName: "Ö",
                          limit: null,
                        },
                        {
                          principal: { type: "user" as const, userId: "66666666-6666-4666-8666-666666666666" },
                          displayName: "山田太郎",
                          limit: 0.01,
                        },
                      ]
                    : []),
                ],
                peopleAtLimit: 4,
              },
              // a rule whose model was removed from the catalog after the rule was made
              ...(input.state === "orphan"
                ? [
                    {
                      scope: "removed-model",
                      hours: 24,
                      anchor: "2026-10-26T00:00:00.000Z",
                      grants: [{ principal: { type: "authenticated" as const }, limit: 5 }],
                      peopleAtLimit: 0,
                    },
                  ]
                : []),
            ],
    },
    personalizationTokens: 100_000,
    spend:
      input.state === "empty"
        ? { cost: 0, accounts: 0, unknown: 0, days: [] }
        : {
            cost: worstCase ? 1_234_567.891 : 184.62,
            accounts: worstCase ? 98_765 : 37,
            unknown: worstCase ? 3 : 0,
            days: [
              3.1, 4.8, 2.2, 6.4, 5.9, 7.7, 1.2, 0.8, 6.1, 8.4, 9.3, 7.2, 5.5, 2.1, 1.4, 6.8, 8.9, 10.2, 9.6, 7.1, 2.4, 1.9, 7.4, 8.8, 9.9,
              11.3, 8.2, 3.6, 2.7, 6.2,
            ],
          },
    models: catalog.models
      .filter((entry) => (entry.kind === "chat" || entry.kind === "decision") && entry.enabled)
      .map((entry) => ({ id: entry.id, label: entry.label, providerId: entry.providerId, priced: Boolean(entry.pricing) })),
  };
};

/** The catalog API of the fixture; it keeps assignments the page saves until the next reset. */
export const createCatalogApi = () => {
  let catalog = aiFixtureCatalog();
  const conflictBody = (current: unknown) =>
    Response.json(
      {
        code: "conflict",
        current,
        changedBy: { id: "22222222-2222-4222-8222-222222222222", name: "Mara Beispiel" },
        changedAt: "2026-10-27T17:42:00.000Z",
      },
      { status: 409 },
    );
  const api: AiFixtureApi = async (request, url, state) => {
    if (url.pathname === "/api/admin/core/ai-quotas/background")
      return Response.json({ used: 12.4, reserved: 0, unknown: 0, stoppedAt: state === "worst" ? "2026-10-27T16:00:00.000Z" : null });
    if (url.pathname.startsWith("/api/admin/core/ai-quotas") && request.method === "GET")
      return Response.json({ enabled: true, revision: 5, rules: [] });
    if (!url.pathname.startsWith("/api/admin/core/ai/")) return undefined;
    const path = url.pathname.replace("/api/admin/core/ai", "");
    if (state === "saving" && request.method !== "GET") return new Promise<Response>(() => {});
    if (request.method === "GET" && path === "/overview") return Response.json(aiFixtureOverview(catalog));
    if (request.method === "GET" && path === "/providers") return Response.json({ providers: catalog.providers });
    if (request.method === "GET" && path === "/models") return Response.json({ models: catalog.models });
    const modelMatch = path.match(/^\/models\/([^/]+)(\/usage)?$/);
    if (request.method === "GET" && modelMatch) {
      const found = catalog.models.find((entry) => entry.id === modelMatch[1]);
      if (!found) return Response.json({ code: "model_not_found" }, { status: 404 });
      if (modelMatch[2]) return Response.json(aiFixtureUsage(found.id));
      return Response.json({ ...found, variants: catalog.variants.filter((entry) => entry.modelId === found.id) });
    }
    const variantUsage = path.match(/^\/variants\/([^/]+)\/usage$/);
    if (request.method === "GET" && variantUsage)
      return Response.json({
        ...aiFixtureUsage(""),
        assignments: (Object.keys(catalog.assignments) as AiModelSlot[]).filter(
          (slot) => catalog.assignments[slot] === decodeURIComponent(variantUsage[1]!),
        ),
      });
    const available = path.match(/^\/providers\/([^/]+)\/available-models$/);
    if (available) {
      if (state === "listfail") return Response.json({ code: "list_failed", message: "Der Anbieter antwortete mit 502." }, { status: 502 });
      if (state === "listempty") return Response.json({ models: [] });
      return Response.json({
        models: [
          { providerModel: "gpt-oss-120b", label: "GPT-OSS 120B", contextWindow: 131_072 },
          { providerModel: "mistral-small", label: "Mistral Small", contextWindow: 32_768 },
          { providerModel: "qwen3-coder-480b", label: "Qwen3 Coder", contextWindow: 262_144 },
          { providerModel: "deepseek-v3", label: "DeepSeek V3", contextWindow: 65_536 },
          { providerModel: "whisper-large-v3", label: "Whisper Large", kind: "transcription" },
        ],
      });
    }
    if (path.endsWith("/test")) return Response.json({ status: state === "badkey" ? "key_rejected" : "ok", message: "", latencyMs: 412 });
    if (state === "conflict") {
      const modelPatch = path.match(/^\/models\/([^/]+)$/);
      if (request.method === "PATCH" && modelPatch) {
        const found = catalog.models.find((entry) => entry.id === modelPatch[1])!;
        return conflictBody({
          ...found,
          revision: found.revision + 1,
          pricing: { inputPerMillion: 0.18, outputPerMillion: 0.6 },
          variants: catalog.variants.filter((entry) => entry.modelId === found.id),
        });
      }
      const slot = path.match(/^\/assignments\/([^/]+)$/);
      if (request.method === "PUT" && slot)
        return conflictBody({
          slot: slot[1],
          variantId: "claude",
          revision: 3,
          updatedAt: "2026-10-27T17:42:00.000Z",
          updatedBy: "22222222-2222-4222-8222-222222222222",
        });
    }
    if (request.method === "PUT" && path.startsWith("/assignments/")) {
      const slot = path.split("/")[2] as AiModelSlot;
      const body = (await request.json()) as { variantId: string | null };
      catalog = { ...catalog, assignments: { ...catalog.assignments, [slot]: body.variantId } };
      return Response.json({ slot, variantId: body.variantId, revision: 3, updatedAt: "2026-10-27T17:50:00.000Z", updatedBy: ADMIN });
    }
    return undefined;
  };
  return {
    api,
    reset() {
      catalog = aiFixtureCatalog();
    },
  };
};
