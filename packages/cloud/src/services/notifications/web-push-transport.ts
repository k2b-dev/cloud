import type { ClientRequest, IncomingMessage } from "node:http";
import { type RequestOptions as HttpsRequestOptions, request as httpsRequest } from "node:https";
import webpush, { type RequestDetails as WebPushRequestDetails, type RequestOptions as WebPushRequestOptions } from "web-push";
import { type BrowserPushSubscription, BrowserPushSubscriptionSchema } from "../../contracts/user-notifications";
import { normalizeNetworkHostname } from "../../shared/network-address";
import { type PublicNetworkAddress, resolvePublicNetworkAddresses } from "../network-security";
import { awaitNetworkOperation, readNetworkResponse, withNetworkDeadline } from "../network-transport";

const RESPONSE_LIMIT_BYTES = 64 * 1_024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ADDRESS_ATTEMPTS = 4;

type RequestFactory = (options: HttpsRequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
type RequestDetailsFactory = (
  subscription: BrowserPushSubscription,
  payload: string,
  options: WebPushRequestOptions,
) => WebPushRequestDetails;

type WebPushTransportDeps = {
  generateRequestDetails?: RequestDetailsFactory;
  request?: RequestFactory;
  signal?: AbortSignal;
  resolve?: (hostname: string) => Promise<PublicNetworkAddress[]>;
};

export const buildPinnedWebPushRequests = async (
  subscription: BrowserPushSubscription,
  payload: string,
  options: WebPushRequestOptions,
  deps: WebPushTransportDeps = {},
): Promise<{ body: Buffer | null; endpoint: string; attempts: HttpsRequestOptions[] }> => {
  const validatedSubscription = BrowserPushSubscriptionSchema.parse(subscription);
  const endpoint = new URL(validatedSubscription.endpoint);
  const hostname = normalizeNetworkHostname(endpoint.hostname);
  deps.signal?.throwIfAborted();
  const resolving = (deps.resolve ?? resolvePublicNetworkAddresses)(hostname);
  const resolvedAddresses = deps.signal ? await awaitNetworkOperation(resolving, deps.signal) : await resolving;
  const uniqueAddresses = resolvedAddresses.filter(
    (target, index) => resolvedAddresses.findIndex((candidate) => candidate.address === target.address) === index,
  );
  const firstFamily = uniqueAddresses[0]?.family ?? 4;
  const primary = uniqueAddresses.filter((target) => target.family === firstFamily);
  const secondary = uniqueAddresses.filter((target) => target.family !== firstFamily);
  const addresses: PublicNetworkAddress[] = [];
  for (let index = 0; addresses.length < MAX_ADDRESS_ATTEMPTS && (index < primary.length || index < secondary.length); index++) {
    const primaryTarget = primary[index];
    const secondaryTarget = secondary[index];
    if (primaryTarget) addresses.push(primaryTarget);
    if (secondaryTarget && addresses.length < MAX_ADDRESS_ATTEMPTS) addresses.push(secondaryTarget);
  }
  if (addresses.length === 0) throw new Error("Push endpoint has no public network address");

  const details = (deps.generateRequestDetails ?? webpush.generateRequestDetails)(validatedSubscription, payload, options);
  if (details.endpoint !== validatedSubscription.endpoint) throw new Error("Web Push request endpoint changed during preparation");
  return {
    body: details.body,
    endpoint: validatedSubscription.endpoint,
    attempts: addresses.map((target) => ({
      protocol: "https:",
      hostname: target.address,
      port: endpoint.port ? Number(endpoint.port) : 443,
      path: `${endpoint.pathname}${endpoint.search}`,
      method: details.method,
      headers: { ...details.headers, host: endpoint.host },
      servername: hostname,
      rejectUnauthorized: true,
    })),
  };
};

const sendPreparedWebPushRequest = (
  request: RequestFactory,
  options: HttpsRequestOptions,
  body: Buffer | null,
  signal: AbortSignal,
): Promise<void> => {
  let responseReceived = false;
  return readNetworkResponse<void>({
    request,
    options,
    body: body ?? undefined,
    signal,
    read: (response, resolve, reject) => {
      responseReceived = true;
      const finish = (result: { error?: Error }) => (result.error ? reject(result.error) : resolve());
      let responseBody = "";
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > RESPONSE_LIMIT_BYTES) {
          finish({ error: new Error("Web Push provider response is too large") });
          return;
        }
        responseBody += chunk.toString();
      });
      response.on("end", () => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 200 && statusCode <= 299) {
          finish({});
          return;
        }
        finish({
          error: Object.assign(new Error("Web Push provider returned an unexpected response"), {
            statusCode,
            responseBody,
          }),
        });
      });
    },
  }).catch((error) => {
    throw responseReceived ? Object.assign(error, { providerResponse: true }) : error;
  });
};

export const sendPinnedWebPush = async (
  subscription: BrowserPushSubscription,
  payload: string,
  options: WebPushRequestOptions,
  deps: WebPushTransportDeps = {},
): Promise<void> =>
  withNetworkDeadline(
    options.timeout ?? REQUEST_TIMEOUT_MS,
    deps.signal,
    new Error("Web Push provider request timed out"),
    async (signal) => {
      const request = deps.request ?? httpsRequest;
      const prepared = await buildPinnedWebPushRequests(subscription, payload, options, { ...deps, signal });
      let lastError: unknown;
      for (const attempt of prepared.attempts) {
        try {
          await sendPreparedWebPushRequest(request, attempt, prepared.body, signal);
          return;
        } catch (error) {
          signal.throwIfAborted();
          if (error && typeof error === "object" && "providerResponse" in error) throw error;
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Web Push provider request failed");
    },
  );
