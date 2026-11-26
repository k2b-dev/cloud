import { type AuthContext, getLocale, getTimeZone, getUserBackedActor } from "@k2b/cloud/server";
import { get as getSetting } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import type { Context } from "hono";
import { webhookTesterService } from "../../service/webhooks";
import { webhookMessages } from "./webhook-messages";
import { type Endpoint, normalizeEndpoint, normalizeLog, type WebhookLog } from "./webhook-queries";
import { logFilters, receivedQuery, sentQuery, type WebhookMode } from "./webhook-query";

/** What the webhook tester's first picture needs, loaded on the server with the same service calls as its API. */
export type WebhookTesterData = {
  mode: WebhookMode;
  /** The address's query (`?…`): the island reads its list state from it with the same declaration. */
  address: string;
  endpoints: Endpoint[];
  logs: WebhookLog[];
  /** Reading the endpoints or the requests failed; the island offers to try again. */
  failed: boolean;
  /** The public Cloud origin, so a receive URL reads the same on the server and in the browser. */
  origin: string;
  timeZone: string;
  /** The server's now, so "heute" means the same day in both renders. */
  now: string;
};

export const loadWebhookTester = async <T extends AuthContext>(c: Context<T>, url: URL): Promise<WebhookTesterData> => {
  const mode: WebhookMode = url.searchParams.get("mode") === "send" ? "send" : "receive";
  const t = webhookMessages.resolve([getLocale(c)]).t;
  const origin = await getSetting<string>("app.url")
    .then((value) => (value ? publicCloudOrigin(value) : url.origin))
    .catch(() => url.origin);
  const base = { mode, address: url.search, origin, timeZone: getTimeZone(c), now: new Date().toISOString() };
  const user = getUserBackedActor(c);
  if (!user) return { ...base, endpoints: [], logs: [], failed: true };
  try {
    const endpoints = (await webhookTesterService.listEndpoints(user.id)).map(normalizeEndpoint);
    const filters = logFilters(
      mode === "send" ? sentQuery(t).parse(url.searchParams).state : receivedQuery(t, endpoints).parse(url.searchParams).state,
    );
    const logs =
      mode === "send"
        ? await webhookTesterService.listOutgoingLogs(user.id, { method: filters.method, query: filters.q })
        : await webhookTesterService.listIncomingLogs(user.id, { endpointId: filters.endpointId, method: filters.method, query: filters.q });
    return { ...base, endpoints, logs: logs.map(normalizeLog), failed: false };
  } catch {
    // The page still opens: the list says it could not be read and offers to try again.
    return { ...base, endpoints: [], logs: [], failed: true };
  }
};
