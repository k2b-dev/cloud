import { request } from "node:https";
import { connect } from "node:tls";
import { DOMAIN_CHECK_PATH_PREFIX, DOMAIN_CHECK_TTL_SECONDS, domainCheckKey } from "../contracts/app-domains";
import { redis } from "../runtime/clients";
import { type PublicNetworkAddress, pinnedNetworkLookup, resolveAllowedNetworkAddresses } from "./network-security";
import { awaitNetworkOperation, readNetworkResponse, withNetworkDeadline } from "./network-transport";

export type AppDomainCheckStep = { ok: boolean; detail: string };
export type AppDomainStatus = {
  checkedAt: string;
  dns: AppDomainCheckStep;
  certificate: AppDomainCheckStep | null;
  reachable: AppDomainCheckStep | null;
};

// Each network stage gets the platform resolver's five-second budget. The challenge lives longer than all stages combined.
const STEP_TIMEOUT_MS = 5000;
const deadline = <T>(work: (signal: AbortSignal) => Promise<T>) =>
  withNetworkDeadline(STEP_TIMEOUT_MS, undefined, new Error("Domain check timed out"), work);

const certificate = (host: string, addresses: PublicNetworkAddress[], signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    // Connect to the checked IP directly; SNI and certificate identity still use the assigned host.
    const socket = connect({ host: addresses[0]!.address, port: 443, servername: host, rejectUnauthorized: true });
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason);
    socket.once("error", finish);
    socket.once("secureConnect", () => finish());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });

const reachable = (host: string, addresses: PublicNetworkAddress[], nonce: string, signal: AbortSignal): Promise<void> =>
  readNetworkResponse({
    request,
    options: {
      hostname: host,
      port: 443,
      servername: host,
      method: "GET",
      path: `${DOMAIN_CHECK_PATH_PREFIX}${nonce}`,
      headers: { accept: "text/plain", "accept-encoding": "identity" },
      lookup: pinnedNetworkLookup(addresses),
      agent: false,
    },
    signal,
    read: (response, resolve, reject) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Gateway check returned HTTP ${response.statusCode}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > nonce.length) reject(new Error("Gateway check returned an unexpected response"));
      });
      response.once("end", () => (body === nonce ? resolve() : reject(new Error("Gateway check did not return the challenge"))));
    },
  });

type DomainCheckDependencies = {
  resolve: (host: string, signal: AbortSignal) => Promise<PublicNetworkAddress[]>;
  certificate: typeof certificate;
  reachable: typeof reachable;
  challenge: (host: string, nonce: string) => Promise<() => Promise<void>>;
  now: () => Date;
  nonce: () => string;
};
const dependencies: DomainCheckDependencies = {
  // Assignment is administrator-only. Its exact host is the operator-controlled allowlist, restricted to TLS port 443.
  resolve: (host, signal) =>
    awaitNetworkOperation(
      resolveAllowedNetworkAddresses(
        host,
        {
          hosts: new Set(),
          networks: [],
          hostPorts: new Map([[host, new Set([443])]]),
        },
        undefined,
        443,
      ),
      signal,
    ),
  certificate,
  reachable,
  challenge: async (host, nonce) => {
    const key = domainCheckKey(host, nonce);
    await redis.set(key, "1", "EX", DOMAIN_CHECK_TTL_SECONDS);
    return async () => {
      await redis.del(key);
    };
  },
  now: () => new Date(),
  nonce: () => crypto.randomUUID(),
};
const failure = (error: unknown): AppDomainCheckStep => ({
  ok: false,
  detail: error instanceof Error ? error.message : "Domain check failed",
});

/** Stop at the first failure. No redirect is followed and no response body can exceed the challenge. */
export const checkAppDomain = async (host: string, overrides: Partial<DomainCheckDependencies> = {}): Promise<AppDomainStatus> => {
  const deps = { ...dependencies, ...overrides };
  const status: AppDomainStatus = {
    checkedAt: deps.now().toISOString(),
    dns: { ok: false, detail: "DNS lookup failed" },
    certificate: null,
    reachable: null,
  };
  let addresses: PublicNetworkAddress[];
  try {
    addresses = await deadline((signal) => deps.resolve(host, signal));
    if (!addresses.length) throw new Error("No A or AAAA records found");
    status.dns = { ok: true, detail: addresses.map((address) => address.address).join(", ") };
  } catch (error) {
    status.dns = failure(error);
    return status;
  }
  try {
    await deadline((signal) => deps.certificate(host, addresses, signal));
    status.certificate = { ok: true, detail: "Valid TLS certificate for this host" };
  } catch (error) {
    status.certificate = failure(error);
    return status;
  }
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const nonce = deps.nonce();
    await deadline(async (signal) => {
      cleanup = await awaitNetworkOperation(deps.challenge(host, nonce), signal);
      await deps.reachable(host, addresses, nonce, signal);
    });
    status.reachable = { ok: true, detail: "Cloud gateway returned the challenge" };
  } catch (error) {
    status.reachable = failure(error);
  } finally {
    // Expiry also removes a challenge if Valkey becomes unavailable during cleanup.
    const removeChallenge = cleanup;
    if (removeChallenge) await deadline(() => removeChallenge()).catch(() => undefined);
  }
  return status;
};
