import { resolveSrv } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { domainToASCII } from "node:url";
import { pinnedNetworkLookup } from "@k2b/cloud/services/network-security";
import {
  awaitNetworkOperation,
  type NetworkRequestFactory,
  readNetworkResponse,
  withNetworkDeadline,
} from "@k2b/cloud/services/network-transport";
import { XMLParser } from "fast-xml-parser";
import type { MailEndpoint } from "../contracts";
import { resolvePublicEndpoint } from "./connectors/endpoint-policy";

const MAX_AUTOCONFIG_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export type MailDiscoverySource = "preset" | "provider_autoconfig" | "thunderbird_autoconfig" | "srv";

export type DiscoveredMailConfiguration = {
  source: MailDiscoverySource;
  email: string;
  username: string;
  imap: MailEndpoint;
  smtp: MailEndpoint;
};

type DiscoveryPreset = Omit<DiscoveredMailConfiguration, "source" | "email" | "username"> & {
  domains: string[];
};

type SrvRecord = { name: string; port: number; priority: number; weight: number };

type DiscoveryDependencies = {
  resolveSrv: (name: string) => Promise<SrvRecord[]>;
  fetchXml: (url: URL, timeoutMs: number, signal: AbortSignal) => Promise<string | null>;
};

const PRESETS: DiscoveryPreset[] = [
  {
    domains: ["gmail.com", "googlemail.com"],
    imap: { host: "imap.gmail.com", port: 993, tlsMode: "implicit" },
    smtp: { host: "smtp.gmail.com", port: 587, tlsMode: "starttls" },
  },
  {
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    imap: { host: "outlook.office365.com", port: 993, tlsMode: "implicit" },
    smtp: { host: "smtp.office365.com", port: 587, tlsMode: "starttls" },
  },
  {
    domains: ["icloud.com", "me.com", "mac.com"],
    imap: { host: "imap.mail.me.com", port: 993, tlsMode: "implicit" },
    smtp: { host: "smtp.mail.me.com", port: 587, tlsMode: "starttls" },
  },
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
});

const arrayOf = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

const normalizeEmail = (raw: string): { email: string; local: string; domain: string } => {
  const email = raw.trim().toLowerCase();
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1 || email.length > 320) throw new Error("A valid email address is required");
  const local = email.slice(0, separator);
  const domain = domainToASCII(email.slice(separator + 1)).toLowerCase();
  if (!domain || domain.length > 253 || domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error("A valid email domain is required");
  }
  return { email: `${local}@${domain}`, local, domain };
};

const substituteUsername = (value: unknown, parts: ReturnType<typeof normalizeEmail>): string => {
  if (typeof value !== "string" || !value.trim()) return parts.email;
  return value
    .replaceAll("%EMAILADDRESS%", parts.email)
    .replaceAll("%EMAILLOCALPART%", parts.local)
    .replaceAll("%EMAILDOMAIN%", parts.domain);
};

const tlsModeFromSocket = (value: unknown): MailEndpoint["tlsMode"] | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "SSL" || normalized === "SSL/TLS") return "implicit";
  if (normalized === "STARTTLS") return "starttls";
  return null;
};

const endpointFromXml = (value: unknown): MailEndpoint | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const host = typeof record.hostname === "string" ? record.hostname.trim().toLowerCase() : "";
  const port = typeof record.port === "number" ? record.port : Number(record.port);
  const tlsMode = tlsModeFromSocket(record.socketType);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535 || !tlsMode) return null;
  return { host, port, tlsMode };
};

export const parseThunderbirdAutoconfig = (params: {
  xml: string;
  email: string;
  source: Extract<MailDiscoverySource, "provider_autoconfig" | "thunderbird_autoconfig">;
}): DiscoveredMailConfiguration[] => {
  const parts = normalizeEmail(params.email);
  const parsed = parser.parse(params.xml) as Record<string, unknown>;
  const clientConfig = parsed.clientConfig;
  if (!clientConfig || typeof clientConfig !== "object") return [];
  const provider = (clientConfig as Record<string, unknown>).emailProvider;
  if (!provider || typeof provider !== "object") return [];
  const providerRecord = provider as Record<string, unknown>;
  const incoming = arrayOf(providerRecord.incomingServer)
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object" && (entry as Record<string, unknown>)["@_type"] === "imap"),
    )
    .flatMap((entry) => {
      const endpoint = endpointFromXml(entry);
      return endpoint ? [{ endpoint, username: substituteUsername(entry.username, parts) }] : [];
    });
  const outgoing = arrayOf(providerRecord.outgoingServer)
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object" && (entry as Record<string, unknown>)["@_type"] === "smtp"),
    )
    .flatMap((entry) => {
      const endpoint = endpointFromXml(entry);
      return endpoint ? [{ endpoint, username: substituteUsername(entry.username, parts) }] : [];
    });
  return incoming.slice(0, 4).flatMap((imap) =>
    outgoing.slice(0, 4).map((smtp) => ({
      source: params.source,
      email: parts.email,
      username: imap.username || smtp.username || parts.email,
      imap: imap.endpoint,
      smtp: smtp.endpoint,
    })),
  );
};

const readPinnedHttps = async (
  url: URL,
  timeoutMs: number,
  signal: AbortSignal,
  deps: {
    resolveEndpoint?: typeof resolvePublicEndpoint;
    request?: NetworkRequestFactory;
  } = {},
): Promise<string | null> => {
  const endpoint = await awaitNetworkOperation(
    (deps.resolveEndpoint ?? resolvePublicEndpoint)({ host: url.hostname, port: 443, tlsMode: "implicit" }, timeoutMs, signal),
    signal,
  );
  signal.throwIfAborted();
  return readNetworkResponse<string | null>({
    request: deps.request ?? httpsRequest,
    signal,
    options: {
      protocol: "https:",
      hostname: endpoint.host,
      servername: endpoint.host,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { accept: "application/xml,text/xml;q=0.9", "user-agent": "Cloud-Mail-Autoconfig/1" },
      lookup: pinnedNetworkLookup(endpoint.addresses),
      // A default agent may route through an environment proxy, which would resolve the name again.
      agent: false,
    },
    read: (response, resolve, reject) => {
      if (response.statusCode === 404) {
        resolve(null);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Autoconfiguration returned HTTP ${response.statusCode ?? "unknown"}`));
        return;
      }
      const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
      if (!contentType.includes("xml")) {
        reject(new Error("Autoconfiguration did not return XML"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_AUTOCONFIG_BYTES) {
          reject(new Error("Autoconfiguration response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    },
  });
};

export const __test = { readPinnedHttps };

const srvCandidates = async (
  parts: ReturnType<typeof normalizeEmail>,
  dependency: DiscoveryDependencies["resolveSrv"],
): Promise<DiscoveredMailConfiguration[]> => {
  const lookup = async (service: string, tlsMode: MailEndpoint["tlsMode"]): Promise<Array<MailEndpoint & SrvRecord>> => {
    try {
      const records = await dependency(`${service}.${parts.domain}`);
      return records
        .filter((record) => record.name !== "." && Number.isInteger(record.port) && record.port > 0 && record.port <= 65_535)
        .sort((left, right) => left.priority - right.priority || right.weight - left.weight || left.name.localeCompare(right.name))
        .slice(0, 4)
        .map((record) => ({ ...record, host: record.name.replace(/\.$/, "").toLowerCase(), tlsMode }));
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "ENODATA" || code === "ENOTFOUND" || code === "ESERVFAIL") return [];
      throw error;
    }
  };
  const [imaps, imap, submissions, submission] = await Promise.all([
    lookup("_imaps._tcp", "implicit"),
    lookup("_imap._tcp", "starttls"),
    lookup("_submissions._tcp", "implicit"),
    lookup("_submission._tcp", "starttls"),
  ]);
  const incoming = [...imaps, ...imap];
  const outgoing = [...submissions, ...submission];
  return incoming.slice(0, 4).flatMap((imapEndpoint) =>
    outgoing.slice(0, 4).map((smtpEndpoint) => ({
      source: "srv" as const,
      email: parts.email,
      username: parts.email,
      imap: { host: imapEndpoint.host, port: imapEndpoint.port, tlsMode: imapEndpoint.tlsMode },
      smtp: { host: smtpEndpoint.host, port: smtpEndpoint.port, tlsMode: smtpEndpoint.tlsMode },
    })),
  );
};

const dedupeCandidates = (candidates: DiscoveredMailConfiguration[]): DiscoveredMailConfiguration[] => {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = [
      candidate.username,
      candidate.imap.host,
      candidate.imap.port,
      candidate.imap.tlsMode,
      candidate.smtp.host,
      candidate.smtp.port,
      candidate.smtp.tlsMode,
    ].join("\n");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const discoverMailConfigurations = async (
  email: string,
  options: { timeoutMs?: number; signal?: AbortSignal; dependencies?: Partial<DiscoveryDependencies> } = {},
): Promise<DiscoveredMailConfiguration[]> => {
  const parts = normalizeEmail(email);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 250), 15_000);
  const dependencies: DiscoveryDependencies = {
    resolveSrv: options.dependencies?.resolveSrv ?? resolveSrv,
    fetchXml: options.dependencies?.fetchXml ?? readPinnedHttps,
  };
  const preset = PRESETS.filter((item) => item.domains.includes(parts.domain)).map((item) => ({
    source: "preset" as const,
    email: parts.email,
    username: parts.email,
    imap: item.imap,
    smtp: item.smtp,
  }));
  const providerUrls = [
    new URL(`https://autoconfig.${parts.domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(parts.email)}`),
    new URL(`https://${parts.domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(parts.email)}`),
  ];
  const providerAutoconfig: DiscoveredMailConfiguration[] = [];
  let thunderbirdAutoconfig: DiscoveredMailConfiguration[] = [];
  let srv: DiscoveredMailConfiguration[] = [];
  try {
    await withNetworkDeadline(timeoutMs, options.signal, new Error("Autoconfiguration request timed out"), async (signal) => {
      const deadline = Date.now() + timeoutMs;
      const fetchXml = (url: URL) => {
        signal.throwIfAborted();
        return awaitNetworkOperation(dependencies.fetchXml(url, Math.max(0, deadline - Date.now()), signal), signal);
      };
      for (const url of providerUrls) {
        try {
          const xml = await fetchXml(url);
          if (xml) providerAutoconfig.push(...parseThunderbirdAutoconfig({ xml, email: parts.email, source: "provider_autoconfig" }));
        } catch {
          // Discovery is best-effort. Connection verification reports actionable endpoint errors later.
        }
      }
      try {
        const url = new URL(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(parts.domain)}`);
        const xml = await fetchXml(url);
        if (xml) thunderbirdAutoconfig = parseThunderbirdAutoconfig({ xml, email: parts.email, source: "thunderbird_autoconfig" });
      } catch {
        // The third-party catalog is optional and receives only the domain.
      }
      try {
        signal.throwIfAborted();
        srv = await awaitNetworkOperation(srvCandidates(parts, dependencies.resolveSrv), signal);
      } catch {
        // Manual setup remains available when DNS discovery is unavailable.
      }
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Keep candidates already found when the shared discovery budget expires.
  }
  return dedupeCandidates([...preset, ...providerAutoconfig, ...thunderbirdAutoconfig, ...srv]).slice(0, 16);
};
