import { query } from "@k2b/stdlib/solid";
import { apiClient } from "@/api/client";

export type SettingEntry = { key: string; value: unknown; default: unknown; description: string };

export type HealthApp = {
  id: string;
  name: string;
  icon: string;
  status: "ok" | "warn" | "error";
  online: boolean;
  signals: string[];
};

export type HealthWebhook = {
  id: string;
  name: string;
  url: string;
  method: "GET" | "POST";
  enabled: boolean;
  scopeKind: "all" | "include" | "exclude";
  scopeAppIds: string[];
  sendOn: ("ok" | "warn" | "error" | "recovery" | "every_check")[];
  minStatus: "ok" | "warn" | "error";
  repeatIntervalMs: number;
  timeoutMs: number;
  lastStatus: "ok" | "warn" | "error" | null;
  lastSentAt: string | null;
  lastError: string | null;
};

export type HealthWebhookInput = Omit<HealthWebhook, "id" | "lastStatus" | "lastSentAt" | "lastError">;

export const responseErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  const data = (await response.json().catch(() => null)) as { message?: string } | null;
  return data?.message ?? fallback;
};

const isHealthWebhook = (value: unknown): value is HealthWebhook =>
  Boolean(value && typeof value === "object" && "id" in value && typeof value.id === "string");

export const readHealthWebhookResponse = async (response: Response, fallback = "Unexpected webhook response."): Promise<HealthWebhook> => {
  const body = await response.json();
  if (isHealthWebhook(body)) return body;
  throw new Error(fallback);
};

export const createHealthWebhookQueries = (messages = {
  loadWebhooks: "Failed to load health webhooks",
  loadSettings: "Failed to load gateway settings",
  loadHealth: "Failed to load gateway health",
}) => {
  const webhooks = query.create<string, HealthWebhook[]>({
    source: () => "health-webhooks",
    load: async (_source, { abortSignal }) => {
      const response = await apiClient.health.webhooks.$get({}, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await responseErrorMessage(response, messages.loadWebhooks));
      return response.json();
    },
  });

  const settings = query.create<string, SettingEntry[]>({
    source: () => "gateway-settings",
    load: async (_source, { abortSignal }) => {
      const response = await apiClient.settings.$get({}, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await responseErrorMessage(response, messages.loadSettings));
      return response.json();
    },
  });

  const health = query.create<string, { apps: HealthApp[] }>({
    source: () => "gateway-health",
    load: async (_source, { abortSignal }) => {
      const response = await apiClient.health.$get({}, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await responseErrorMessage(response, messages.loadHealth));
      return response.json();
    },
  });

  return { health, settings, webhooks };
};
