import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import {
  type FetchMessageObject,
  ImapFlow,
  type ImapFlowOptions,
  type ListResponse,
  type MessageAddressObject,
  type MessageStructureObject,
} from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer, { type Transporter } from "nodemailer";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { z } from "zod";
import type {
  ConnectorCapabilities,
  ConnectorVerification,
  FolderRole,
  ProviderConnectionInput,
  ProviderLimitSnapshot,
  ProviderTransportDiagnostic,
  ProviderTransportDiagnostics,
  RemoteFolder,
  RemoteNamespace,
  SmtpTransportCapabilities,
} from "../../contracts";
import { EMPTY_MESSAGE_PROTOCOL_FACTS, extractMessageProtocolFacts } from "../message-protocol";
import { providerErrorDetail } from "../provider-errors";
import type {
  ConnectorAddress,
  ConnectorChangeListener,
  ConnectorChangeListenerRequest,
  ConnectorEnvelope,
  ConnectorProtocolFacts,
  EnvelopeBatch,
  EnvelopeBatchRequest,
  FlagChange,
  FolderStatusSnapshot,
  MailConnector,
  RemoteAppendResult,
  RemoteCopyResult,
  RemoteMessageState,
  RemoteMessageStateChange,
  RemoteMutationTarget,
  SendRequest,
  SendResult,
  SendSourceRequest,
  SmtpConnectionConfig,
  SourceDownload,
  SourceDownloadRequest,
} from "./contract";
import { createPinnedLookup, type ResolvedEndpoint, resolvePublicEndpoint } from "./endpoint-policy";
import { readImapAclRights, selectFallbackRights } from "./imap-acl";
import { appendStream } from "./imap-append-stream";
import { openImapChangeListener } from "./imap-listener";

type NamespaceEntry = { prefix: string; delimiter: string | null };
type ImapFlowNamespaces = {
  personal?: NamespaceEntry[] | false;
  other?: NamespaceEntry[] | false;
  shared?: NamespaceEntry[] | false;
};
type ImapFlowWithNamespaces = ImapFlow & { namespaces?: ImapFlowNamespaces };

// The largest message literal ImapFlow will accept from a server. Anything
// bigger cannot be fetched at all, so it is also the hydration ceiling.
export const MAX_IMAP_LITERAL_BYTES = 128 * 1024 * 1024;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const authForImap = (config: ProviderConnectionInput): NonNullable<ImapFlowOptions["auth"]> => ({
  user: config.username,
  pass: config.secret.password,
});

const authForSmtp = (config: SmtpConnectionConfig): SMTPTransport.Options["auth"] => ({
  user: config.username,
  pass: config.secret.password,
});

const createImapClient = (config: ProviderConnectionInput, endpoint: ResolvedEndpoint): ImapFlow =>
  new ImapFlow({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.tlsMode === "implicit",
    doSTARTTLS: endpoint.tlsMode === "starttls",
    servername: isIP(endpoint.host) ? undefined : endpoint.host,
    auth: authForImap(config),
    clientInfo: { name: "Cloud Mail", vendor: "Cloud", version: "1" },
    logger: false,
    logRaw: false,
    emitLogs: false,
    disableCompression: true,
    disableAutoIdle: true,
    qresync: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    maxLineLength: 8 * 1024 * 1024,
    maxLiteralSize: MAX_IMAP_LITERAL_BYTES,
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      lookup: createPinnedLookup(endpoint),
    },
  });

type DisposableImapClient = Pick<ImapFlow, "close" | "logout" | "usable">;

export const disposeImapClient = async (client: DisposableImapClient): Promise<void> => {
  // ImapFlow has already closed the socket when `usable` is false. Calling
  // close() again rejects its drained request queue and can surface as an
  // unhandled NoConnection rejection.
  if (!client.usable) return;
  try {
    await client.logout();
  } catch {
    if (client.usable) client.close();
  }
};

const withImapClient = async <T>(
  config: ProviderConnectionInput,
  fn: (client: ImapFlowWithNamespaces) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  const throwIfAborted = (): void => {
    if (signal?.aborted) {
      throw signal.reason ?? Object.assign(new Error("IMAP operation was aborted"), { name: "AbortError" });
    }
  };
  throwIfAborted();
  const endpoint = await resolvePublicEndpoint(config.imap);
  const client = createImapClient(config, endpoint) as ImapFlowWithNamespaces;
  const abort = (): void => client.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.connect();
    throwIfAborted();
    const result = await fn(client);
    throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    await disposeImapClient(client);
  }
};

const capability = (client: ImapFlow, name: string): boolean => client.capabilities.has(name) || client.enabled.has(name);

const mapCapabilities = (client: ImapFlow): ConnectorCapabilities => ({
  idle: capability(client, "IDLE"),
  condstore: capability(client, "CONDSTORE"),
  qresync: capability(client, "QRESYNC"),
  move: capability(client, "MOVE"),
  uidplus: capability(client, "UIDPLUS"),
  namespace: capability(client, "NAMESPACE"),
  listExtended: capability(client, "LIST-EXTENDED"),
  specialUse: capability(client, "SPECIAL-USE"),
  acl: capability(client, "ACL"),
  notify: capability(client, "NOTIFY"),
  quota: capability(client, "QUOTA"),
  gmailExtensions: capability(client, "X-GM-EXT-1"),
});

const unavailableImapLimits = (): ProviderLimitSnapshot["imap"] => ({
  status: "unavailable",
  storage: null,
  messages: null,
});

const imapQuotaResourceSchema = z
  .object({
    used: z.number().int().nonnegative().optional(),
    usage: z.number().int().nonnegative().optional(),
    limit: z.number().int().nonnegative(),
  })
  .refine((resource) => resource.used !== undefined || resource.usage !== undefined, "Quota usage is required");

const imapQuotaEvidenceSchema = z
  .object({
    storage: imapQuotaResourceSchema.optional(),
    messages: imapQuotaResourceSchema.optional(),
    message: imapQuotaResourceSchema.optional(),
  })
  .passthrough();

const normalizeQuotaResource = (resource: z.infer<typeof imapQuotaResourceSchema> | undefined): { used: number; limit: number } | null => {
  if (!resource) return null;
  const used = resource.used ?? resource.usage;
  return used === undefined ? null : { used, limit: resource.limit };
};

export const normalizeImapQuotaEvidence = (value: unknown): ProviderLimitSnapshot["imap"] | null => {
  const parsed = imapQuotaEvidenceSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    status: "supported",
    storage: normalizeQuotaResource(parsed.data.storage),
    messages: normalizeQuotaResource(parsed.data.messages ?? parsed.data.message),
  };
};

const readImapLimits = async (client: ImapFlow): Promise<ProviderLimitSnapshot["imap"]> => {
  if (!capability(client, "QUOTA")) {
    return { status: "unsupported", storage: null, messages: null };
  }
  try {
    const quota = await client.getQuota("INBOX");
    if (!quota) return unavailableImapLimits();
    return normalizeImapQuotaEvidence(quota) ?? unavailableImapLimits();
  } catch {
    return unavailableImapLimits();
  }
};

const mapNamespaces = (client: ImapFlowWithNamespaces): RemoteNamespace[] => {
  const namespaces = client.namespaces;
  const mapped: RemoteNamespace[] = [];
  for (const entry of namespaces?.personal || []) mapped.push({ kind: "personal", prefix: entry.prefix, delimiter: entry.delimiter });
  for (const entry of namespaces?.other || []) mapped.push({ kind: "other_users", prefix: entry.prefix, delimiter: entry.delimiter });
  for (const entry of namespaces?.shared || []) mapped.push({ kind: "shared", prefix: entry.prefix, delimiter: entry.delimiter });
  return mapped.length > 0 ? mapped : [{ kind: "personal", prefix: "", delimiter: null }];
};

const verifyImap = async (
  config: ProviderConnectionInput,
  signal?: AbortSignal,
): Promise<
  Omit<ConnectorVerification, "accounts" | "limits"> & {
    namespaces: RemoteNamespace[];
    limits: ProviderLimitSnapshot["imap"];
  }
> =>
  withImapClient(
    config,
    async (client) => {
      const limits = await readImapLimits(client);
      return {
        authenticatedPrincipal: typeof client.authenticated === "string" ? client.authenticated : config.username,
        serverIdentity: {
          host: config.imap.host,
          port: config.imap.port,
          tlsMode: config.imap.tlsMode,
          secureConnection: client.secureConnection,
          serverInfo: client.serverInfo ?? {},
          advertisedCapabilities: [...client.capabilities.keys()].sort(),
        },
        capabilities: mapCapabilities(client),
        namespaces: mapNamespaces(client),
        limits,
      };
    },
    signal,
  );

const smtpOptions = (config: SmtpConnectionConfig, endpoint: ResolvedEndpoint, address: string): SMTPTransport.Options => ({
  host: address,
  port: endpoint.port,
  secure: endpoint.tlsMode === "implicit",
  requireTLS: endpoint.tlsMode === "starttls",
  ignoreTLS: false,
  auth: authForSmtp(config),
  name: "cloud-mail",
  logger: false,
  debug: false,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 60_000,
  disableFileAccess: true,
  disableUrlAccess: true,
  tls: {
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    servername: isIP(endpoint.host) ? undefined : endpoint.host,
  },
});

const withSmtpTransport = async <T>(
  config: SmtpConnectionConfig,
  fn: (transport: Transporter<SMTPTransport.SentMessageInfo>) => Promise<T>,
  options: { allowAddressFailover?: boolean; signal?: AbortSignal } = {},
): Promise<T> => {
  const throwIfAborted = (): void => {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? Object.assign(new Error("SMTP operation was aborted"), { name: "AbortError" });
    }
  };
  throwIfAborted();
  const endpoint = await resolvePublicEndpoint(config.smtp);
  let lastError: unknown;
  const addresses = options.allowAddressFailover ? endpoint.addresses : endpoint.addresses.slice(0, 1);
  for (const resolved of addresses) {
    throwIfAborted();
    const transport = nodemailer.createTransport(smtpOptions(config, endpoint, resolved.address));
    const abort = (): void => transport.close();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await fn(transport);
    } catch (error) {
      throwIfAborted();
      lastError = error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      transport.close();
    }
  }
  throw lastError ?? new Error("SMTP endpoint did not provide a usable address");
};

const verifySmtp = async (config: SmtpConnectionConfig, signal?: AbortSignal): Promise<void> =>
  withSmtpTransport(
    config,
    async (transport) => {
      await transport.verify();
    },
    { allowAddressFailover: true, signal },
  );

const smtpCapabilityEvidenceSchema = z.object({
  extensions: z.array(z.string()),
  maxAllowedSize: z.number().int().nonnegative(),
});

type SmtpConnectionCapabilityEvidence = {
  _supportedExtensions?: unknown;
  _maxAllowedSize?: unknown;
};

const readSmtpCapabilityEvidence = (connection: SMTPConnection): z.infer<typeof smtpCapabilityEvidenceSchema> => {
  // Nodemailer parses RFC 1870 but does not expose the result in its public types.
  const internal = connection as SMTPConnection & SmtpConnectionCapabilityEvidence;
  const parsed = smtpCapabilityEvidenceSchema.safeParse({
    extensions: internal._supportedExtensions,
    maxAllowedSize: internal._maxAllowedSize,
  });
  if (!parsed.success) throw Object.assign(new Error("SMTP capability evidence is unavailable"), { code: "SMTP_LIMIT_UNAVAILABLE" });
  return parsed.data;
};

const smtpConnectionOptions = (config: SmtpConnectionConfig, endpoint: ResolvedEndpoint, address: string): SMTPConnection.Options => ({
  host: address,
  port: endpoint.port,
  secure: endpoint.tlsMode === "implicit",
  requireTLS: endpoint.tlsMode === "starttls",
  ignoreTLS: false,
  name: "cloud-mail",
  logger: false,
  debug: false,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 60_000,
  tls: {
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    servername: isIP(endpoint.host) ? undefined : endpoint.host,
  },
});

/**
 * Opens an SMTP connection for capability evidence. Nodemailer neither calls
 * back nor emits an error when the server closes the socket before its
 * greeting, so the connection's end settles the attempt as well. Aborting
 * settles with the abort reason and closes the connection.
 */
export const connectSmtpConnection = (connection: SMTPConnection, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const settle = (error?: Error): void => {
      connection.off("error", settle);
      connection.off("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onEnd = (): void =>
      settle(Object.assign(new Error("SMTP connection closed before the handshake completed"), { code: "ECONNECTION" }));
    const onAbort = (): void => {
      settle(signal?.reason ?? Object.assign(new Error("SMTP operation was aborted"), { name: "AbortError" }));
      connection.close();
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    connection.once("error", settle);
    connection.once("end", onEnd);
    connection.connect((error) => settle(error));
  });

const connectForSmtpCapabilities = async (
  config: SmtpConnectionConfig,
  endpoint: ResolvedEndpoint,
  address: string,
  signal?: AbortSignal,
): Promise<ProviderLimitSnapshot["smtp"]> => {
  const connection = new SMTPConnection(smtpConnectionOptions(config, endpoint, address));
  try {
    await connectSmtpConnection(connection, signal);
    const evidence = readSmtpCapabilityEvidence(connection);
    if (!evidence.extensions.includes("SIZE")) {
      return { status: "unsupported", maxMessageBytes: null, dsn: evidence.extensions.includes("DSN") };
    }
    return {
      status: "supported",
      maxMessageBytes: evidence.maxAllowedSize > 0 ? evidence.maxAllowedSize : null,
      dsn: evidence.extensions.includes("DSN"),
    };
  } finally {
    connection.close();
  }
};

const discoverSmtpLimits = async (config: ProviderConnectionInput, signal?: AbortSignal): Promise<ProviderLimitSnapshot["smtp"]> => {
  try {
    const endpoint = await resolvePublicEndpoint(config.smtp);
    let lastError: unknown;
    for (const resolved of endpoint.addresses) {
      try {
        return await connectForSmtpCapabilities(config, endpoint, resolved.address, signal);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("SMTP endpoint did not provide a usable address");
  } catch {
    return { status: "unavailable", maxMessageBytes: null, dsn: false };
  }
};

const verifySmtpTransport = async (config: SmtpConnectionConfig): Promise<SmtpTransportCapabilities> => {
  await verifySmtp(config);
  const endpoint = await resolvePublicEndpoint(config.smtp);
  let lastError: unknown;
  for (const resolved of endpoint.addresses) {
    const connection = new SMTPConnection(smtpConnectionOptions(config, endpoint, resolved.address));
    try {
      await connectSmtpConnection(connection);
      const evidence = readSmtpCapabilityEvidence(connection);
      return {
        dsn: evidence.extensions.includes("DSN"),
        size: evidence.extensions.includes("SIZE"),
        maxMessageBytes: evidence.extensions.includes("SIZE") && evidence.maxAllowedSize > 0 ? evidence.maxAllowedSize : null,
      };
    } catch (error) {
      lastError = error;
    } finally {
      connection.close();
    }
  }
  throw lastError ?? new Error("SMTP endpoint did not provide capability evidence");
};

const discoverImapLimits = async (config: ProviderConnectionInput): Promise<ProviderLimitSnapshot["imap"]> => {
  try {
    return await withImapClient(config, readImapLimits);
  } catch {
    return unavailableImapLimits();
  }
};

const discoverLimits = async (config: ProviderConnectionInput): Promise<ProviderLimitSnapshot> => {
  const checkedAt = new Date().toISOString();
  const [imap, smtp] = await Promise.all([discoverImapLimits(config), discoverSmtpLimits(config)]);
  return { checkedAt, imap, smtp };
};

export const transportDiagnostic = (
  result: PromiseSettledResult<unknown>,
  secrets: readonly string[] = [],
): ProviderTransportDiagnostic => {
  if (result.status === "fulfilled") return { status: "verified", category: null, message: "Verified" };
  const error = result.reason as { code?: unknown; message?: unknown; authenticationFailed?: unknown } | null;
  const code = typeof error?.code === "string" ? error.code.toUpperCase() : "";
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  const category =
    error?.authenticationFailed === true || code.includes("AUTH") || message.includes("auth") || message.includes("credential")
      ? "authentication"
      : code.includes("CERT") || code.includes("TLS") || message.includes("certificate") || message.includes("tls")
        ? "tls"
        : code === "ENDPOINT_BLOCKED" || message.includes("endpoint") || message.includes("resolve")
          ? "endpoint"
          : code.includes("TIMEOUT") || code.includes("CONNECTION") || message.includes("connect") || message.includes("timeout")
            ? "unavailable"
            : "unknown";
  const safeMessage =
    category === "authentication"
      ? "Authentication failed"
      : category === "tls"
        ? "TLS verification failed"
        : category === "endpoint"
          ? "Endpoint policy rejected the server"
          : category === "unavailable"
            ? "Server could not be reached"
            : "Verification failed";
  const detail = providerErrorDetail(result.reason, secrets);
  return { status: "failed", category, message: detail ? `${safeMessage}: ${detail}` : safeMessage };
};

export const verifyImapSmtpTransports = async (
  config: ProviderConnectionInput,
  signal?: AbortSignal,
): Promise<{ verification: ConnectorVerification | null; diagnostics: ProviderTransportDiagnostics }> => {
  const checkedAt = new Date().toISOString();
  const [imap, smtp] = await Promise.allSettled([
    verifyImap(config, signal),
    Promise.all([verifySmtp(config, signal), discoverSmtpLimits(config, signal)]).then(([, limits]) => limits),
  ]);
  const secrets = [config.secret.password];
  const diagnostics = {
    imap: transportDiagnostic(imap, secrets),
    smtp: transportDiagnostic(smtp, secrets),
  } satisfies ProviderTransportDiagnostics;
  if (imap.status === "rejected" || smtp.status === "rejected") return { verification: null, diagnostics };
  const accountId = sha256(`${config.imap.host.toLowerCase()}\n${imap.value.authenticatedPrincipal.toLowerCase()}`);
  return {
    diagnostics,
    verification: {
      authenticatedPrincipal: imap.value.authenticatedPrincipal,
      serverIdentity: imap.value.serverIdentity,
      capabilities: imap.value.capabilities,
      limits: { checkedAt, imap: imap.value.limits, smtp: smtp.value },
      accounts: [{ id: accountId, name: config.email, locator: { accountId }, namespaces: imap.value.namespaces }],
    },
  };
};

const roleFromList = (entry: ListResponse): FolderRole => {
  if (entry.path.toUpperCase() === "INBOX") return "inbox";
  switch (entry.specialUse?.toLowerCase()) {
    case "\\sent":
      return "sent";
    case "\\drafts":
      return "drafts";
    case "\\trash":
      return "trash";
    case "\\archive":
      return "archive";
    case "\\junk":
      return "junk";
    case "\\all":
      return "all";
    default:
      return "other";
  }
};

const stableFolderKey = (entry: ListResponse): string => sha256(`${entry.path}\n${entry.status?.uidValidity?.toString() ?? "unknown"}`);

const mapFolder = (entry: ListResponse): RemoteFolder => ({
  stableKey: stableFolderKey(entry),
  path: entry.path,
  name: entry.name || entry.path,
  delimiter: entry.delimiter || null,
  parentPath: entry.parentPath || null,
  role: roleFromList(entry),
  subscribed: entry.subscribed === true,
  selectable: !entry.flags.has("\\Noselect"),
  uidValidity: entry.status?.uidValidity?.toString() ?? null,
  uidNext: entry.status?.uidNext?.toString() ?? null,
  highestModseq: entry.status?.highestModseq?.toString() ?? null,
  rights: [],
  rightsSource: "unknown",
});

const mapAddress = (address: MessageAddressObject): ConnectorAddress | null => {
  const normalized = address.address?.trim().toLowerCase();
  return normalized ? { name: address.name?.trim() || null, address: normalized } : null;
};

const mapAddresses = (addresses: MessageAddressObject[] | undefined): ConnectorAddress[] =>
  (addresses ?? []).map(mapAddress).filter((address): address is ConnectorAddress => address !== null);

const structureToJson = (structure: MessageStructureObject | undefined): Record<string, unknown> => {
  if (!structure) return {};
  return {
    part: structure.part ?? null,
    type: structure.type,
    parameters: structure.parameters ?? {},
    id: structure.id ?? null,
    encoding: structure.encoding ?? null,
    size: structure.size ?? null,
    disposition: structure.disposition ?? null,
    dispositionParameters: structure.dispositionParameters ?? {},
    childNodes: structure.childNodes?.map((child) => structureToJson(child)) ?? [],
  };
};

const rawHeaderText = (lines: readonly { key: string; line: string }[], name: string): string | null => {
  const line = lines.find((candidate) => candidate.key.toLowerCase() === name)?.line;
  if (!line) return null;
  const separator = line.indexOf(":");
  return separator >= 0 ? line.slice(separator + 1).trim() || null : null;
};

export const parseEnvelopeHeaders = async (
  headers: Buffer | undefined,
): Promise<{ references: string[]; protocolFacts: ConnectorProtocolFacts }> => {
  const empty = {
    references: [],
    protocolFacts: EMPTY_MESSAGE_PROTOCOL_FACTS,
  } satisfies { references: string[]; protocolFacts: ConnectorProtocolFacts };
  if (!headers?.length) return empty;
  const parsed = await simpleParser(headers, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const references = Array.isArray(parsed.references)
    ? parsed.references.map(String).filter(Boolean)
    : typeof parsed.references === "string"
      ? (parsed.references.match(/<[^>]+>/g) ?? parsed.references.split(/\s+/).filter(Boolean))
      : [];
  const header = (name: string): unknown => rawHeaderText(parsed.headerLines, name) ?? parsed.headers.get(name);
  return {
    references,
    protocolFacts: extractMessageProtocolFacts(header),
  };
};

export const parseReferences = async (headers: Buffer | undefined): Promise<string[]> => (await parseEnvelopeHeaders(headers)).references;

const mapFetchedEnvelope = async (message: FetchMessageObject, request: EnvelopeBatchRequest): Promise<ConnectorEnvelope> => {
  const envelope = message.envelope;
  const state = splitRemoteFlags(message.flags ?? []);
  const parsedHeaders = await parseEnvelopeHeaders(message.headers);
  return {
    remoteRef: {
      folderStableKey: request.folderStableKey,
      uidValidity: request.uidValidity,
      uid: String(message.uid),
      modseq: message.modseq?.toString() ?? null,
    },
    providerMessageId: message.emailId ?? null,
    providerThreadId: message.threadId ?? null,
    messageId: envelope?.messageId?.trim() || null,
    inReplyTo: envelope?.inReplyTo?.trim() || null,
    references: parsedHeaders.references,
    protocolFacts: parsedHeaders.protocolFacts,
    subject: envelope?.subject ?? "",
    sentAt: envelope?.date ?? null,
    internalDate: message.internalDate ? new Date(message.internalDate) : (envelope?.date ?? new Date(0)),
    sizeBytes: message.size ?? 0,
    flags: state.flags,
    labels: [...new Set([...state.keywords, ...(message.labels ?? [])])].sort(),
    addresses: {
      from: mapAddresses(envelope?.from),
      replyTo: mapAddresses(envelope?.replyTo),
      to: mapAddresses(envelope?.to),
      cc: mapAddresses(envelope?.cc),
      bcc: mapAddresses(envelope?.bcc),
    },
    mimeStructure: structureToJson(message.bodyStructure),
  };
};

const splitRemoteFlags = (values: Iterable<string>): { flags: string[]; keywords: string[] } => {
  const flags: string[] = [];
  const keywords: string[] = [];
  for (const value of values) (value.startsWith("\\") ? flags : keywords).push(value);
  return { flags: [...new Set(flags)].sort(), keywords: [...new Set(keywords)].sort() };
};

export const selectUidBatch = async (params: {
  lowUid: number;
  highUid: number;
  limit: number;
  search: (lowUid: number, highUid: number) => Promise<number[]>;
}): Promise<{ uids: number[]; nextHighUid: number | null }> => {
  const lowUid = Math.max(1, Math.floor(params.lowUid));
  const highUid = Math.max(lowUid, Math.floor(params.highUid));
  const limit = Math.max(1, Math.floor(params.limit));
  let span = Math.min(highUid - lowUid + 1, limit * 4);

  while (true) {
    const probeLow = Math.max(lowUid, highUid - span + 1);
    const matches = [...new Set(await params.search(probeLow, highUid))]
      .filter((uid) => Number.isInteger(uid) && uid >= probeLow && uid <= highUid)
      .sort((left, right) => left - right);
    if (matches.length >= limit || probeLow === lowUid) {
      const uids = matches.slice(-limit);
      const firstUid = uids[0];
      return {
        uids,
        nextHighUid: probeLow === lowUid && matches.length <= limit ? null : firstUid != null && firstUid > lowUid ? firstUid - 1 : null,
      };
    }
    span = Math.min(highUid - lowUid + 1, span * 4);
  }
};

const verify = async (config: ProviderConnectionInput, signal?: AbortSignal): Promise<ConnectorVerification> => {
  const result = await verifyImapSmtpTransports(config, signal);
  if (result.verification) return result.verification;
  const summary = `IMAP: ${result.diagnostics.imap.message}; SMTP: ${result.diagnostics.smtp.message}`;
  throw Object.assign(new Error(summary), { code: "PROVIDER_TRANSPORT_VERIFICATION_FAILED", diagnostics: result.diagnostics });
};

const isServerRefusal = (error: unknown): boolean => {
  const status = (error as { responseStatus?: unknown } | null)?.responseStatus;
  return status === "NO" || status === "BAD";
};

const discoverFolders = async (config: ProviderConnectionInput, signal?: AbortSignal): Promise<RemoteFolder[]> =>
  withImapClient(
    config,
    async (client) => {
      const folders = await client.list({
        statusQuery: { messages: true, uidNext: true, uidValidity: true, unseen: true, highestModseq: true },
      });
      const capabilities = mapCapabilities(client);
      const result: RemoteFolder[] = [];
      for (const entry of folders) {
        const folder = mapFolder(entry);
        if (!folder.selectable) {
          result.push(folder);
          continue;
        }
        const aclRights = await readImapAclRights(client, entry.path, capabilities);
        if (aclRights) {
          folder.rights = aclRights.rights;
          folder.rightsSource = aclRights.source;
          result.push(folder);
          continue;
        }
        try {
          const lock = await client.getMailboxLock(entry.path, { readOnly: false });
          try {
            const readOnly = !client.mailbox || client.mailbox.readOnly === true;
            const fallback = selectFallbackRights(readOnly, capabilities);
            folder.rights = fallback.rights;
            folder.rightsSource = fallback.source;
          } finally {
            lock.release();
          }
        } catch (error) {
          // A server that refuses to select the folder answers NO/BAD; anything
          // else (socket, TLS, auth) is transient and must fail discovery.
          if (!isServerRefusal(error)) throw error;
          folder.rights = [];
          folder.rightsSource = "unknown";
        }
        result.push(folder);
      }
      return result;
    },
    signal,
  );

const fetchEnvelopeBatch = async (
  config: ProviderConnectionInput,
  request: EnvelopeBatchRequest,
  signal?: AbortSignal,
): Promise<EnvelopeBatch> =>
  withImapClient(
    config,
    async (client) => {
      const lock = await client.getMailboxLock(request.folderPath, { readOnly: true });
      try {
        assertSelectedMailbox(client, request.uidValidity);
        const highUid = Math.max(1, request.highUid);
        const lowUid = Math.max(1, request.lowUid ?? 1);
        const selected = request.uids
          ? { uids: [...new Set(request.uids)].sort((left, right) => left - right), nextHighUid: null }
          : await selectUidBatch({
              lowUid,
              highUid,
              limit: request.limit,
              search: async (probeLow, probeHigh) => {
                const matches = await client.search({ uid: `${probeLow}:${probeHigh}` }, { uid: true });
                assertSelectedMailbox(client, request.uidValidity);
                return matches || [];
              },
            });
        const fetched: FetchMessageObject[] = [];
        if (selected.uids.length > 0) {
          for await (const message of client.fetch(
            selected.uids,
            {
              uid: true,
              flags: true,
              envelope: true,
              bodyStructure: true,
              internalDate: true,
              size: true,
              threadId: true,
              labels: true,
              headers: [
                "references",
                "return-path",
                "auto-submitted",
                "precedence",
                "list-id",
                "list-unsubscribe",
                "list-unsubscribe-post",
                "list-post",
                "list-help",
                "list-archive",
                "x-auto-response-suppress",
                "content-type",
                "importance",
                "priority",
                "x-priority",
                "disposition-notification-to",
                "x-spam-flag",
                "x-spam-status",
                "x-spam-score",
              ],
            },
            { uid: true },
          )) {
            fetched.push(message);
          }
          assertSelectedMailbox(client, request.uidValidity);
        }
        fetched.sort((left, right) => right.uid - left.uid);
        const messages = await Promise.all(fetched.map((message) => mapFetchedEnvelope(message, request)));
        return { messages, nextHighUid: selected.nextHighUid };
      } finally {
        lock.release();
      }
    },
    signal,
  );

const getFolderStatus = async (config: ProviderConnectionInput, folderPath: string, signal?: AbortSignal): Promise<FolderStatusSnapshot> =>
  withImapClient(
    config,
    async (client) => {
      const status = await client.status(folderPath, {
        messages: true,
        uidNext: true,
        uidValidity: true,
        highestModseq: true,
      });
      if (!status.uidValidity || !status.uidNext) {
        throw Object.assign(new Error("Provider folder status is incomplete"), { code: "INCOMPLETE_FOLDER_STATUS" });
      }
      return {
        uidValidity: status.uidValidity.toString(),
        uidNext: status.uidNext,
        highestModseq: status.highestModseq?.toString() ?? null,
        messages: status.messages ?? 0,
      };
    },
    signal,
  );

const fetchFlagChanges = async (
  config: ProviderConnectionInput,
  folderPath: string,
  uidValidity: string,
  sinceModseq: string,
  lowUid: number,
  highUid: number,
  signal?: AbortSignal,
): Promise<FlagChange[]> =>
  withImapClient(
    config,
    async (client) => {
      const lock = await client.getMailboxLock(folderPath, { readOnly: true });
      try {
        assertSelectedMailbox(client, uidValidity);
        const changes: FlagChange[] = [];
        for await (const message of client.fetch(
          `${Math.max(1, lowUid)}:${Math.max(1, highUid)}`,
          { uid: true, flags: true, labels: true },
          { uid: true, changedSince: BigInt(sinceModseq) },
        )) {
          const state = splitRemoteFlags(message.flags ?? []);
          changes.push({
            uid: message.uid,
            modseq: message.modseq?.toString() ?? null,
            flags: state.flags,
            labels: [...new Set([...state.keywords, ...(message.labels ?? [])])].sort(),
          });
        }
        assertSelectedMailbox(client, uidValidity);
        return changes;
      } finally {
        lock.release();
      }
    },
    signal,
  );

const fetchUidWindow = async (
  config: ProviderConnectionInput,
  folderPath: string,
  uidValidity: string,
  lowUid: number,
  highUid: number,
  signal?: AbortSignal,
): Promise<FlagChange[]> =>
  withImapClient(
    config,
    async (client) => {
      const lock = await client.getMailboxLock(folderPath, { readOnly: true });
      try {
        assertSelectedMailbox(client, uidValidity);
        const entries: FlagChange[] = [];
        for await (const message of client.fetch(
          `${Math.max(1, lowUid)}:${Math.max(1, highUid)}`,
          { uid: true, flags: true, labels: true },
          { uid: true },
        )) {
          const state = splitRemoteFlags(message.flags ?? []);
          entries.push({
            uid: message.uid,
            modseq: message.modseq?.toString() ?? null,
            flags: state.flags,
            labels: [...new Set([...state.keywords, ...(message.labels ?? [])])].sort(),
          });
        }
        assertSelectedMailbox(client, uidValidity);
        return entries.sort((left, right) => left.uid - right.uid);
      } finally {
        lock.release();
      }
    },
    signal,
  );

const downloadSourceBatch = async (
  config: ProviderConnectionInput,
  folderPath: string,
  requests: SourceDownloadRequest[],
  consume: (source: SourceDownload) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> =>
  withImapClient(
    config,
    async (client) => {
      if (requests.length === 0) return;
      const expectedUidValidities = new Set(requests.map((request) => request.uidValidity));
      if (expectedUidValidities.size !== 1) {
        throw Object.assign(new Error("Source batch contains multiple UIDVALIDITY values"), { code: "INVALID_SOURCE_BATCH" });
      }
      const lock = await client.getMailboxLock(folderPath, { readOnly: true });
      try {
        assertSelectedUidValidity(client, requests[0]!.uidValidity);
        for (const request of requests) {
          const download = await client.download(request.uid, undefined, { uid: true });
          try {
            await consume({
              ...request,
              expectedSize: download.meta.expectedSize,
              stream: download.content,
            });
          } finally {
            if (!download.content.destroyed) download.content.destroy();
          }
        }
      } finally {
        lock.release();
      }
    },
    signal,
  );

const send = async (config: ProviderConnectionInput, request: SendRequest): Promise<SendResult> =>
  withSmtpTransport(config, async (transport) => {
    const formatAddress = (address: { name?: string | null; address: string }) => ({
      name: address.name?.trim() ?? "",
      address: address.address,
    });
    const info = await transport.sendMail({
      from: formatAddress(request.from),
      replyTo: request.replyTo ?? undefined,
      envelope: request.envelopeFrom
        ? { from: request.envelopeFrom, to: [...request.to, ...(request.cc ?? []), ...(request.bcc ?? [])].map((item) => item.address) }
        : undefined,
      to: request.to.map(formatAddress),
      cc: request.cc?.map(formatAddress),
      bcc: request.bcc?.map(formatAddress),
      subject: request.subject,
      text: request.text,
      html: request.html ?? undefined,
      messageId: request.messageId,
      inReplyTo: request.inReplyTo ?? undefined,
      references: request.references,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return {
      accepted: info.accepted.map(String),
      rejected: info.rejected.map(String),
      response: info.response ?? "",
      messageId: info.messageId,
    };
  });

const sendSource = async (config: SmtpConnectionConfig, request: SendSourceRequest): Promise<SendResult> =>
  withSmtpTransport(
    config,
    async (transport) => {
      const abort = (): void => {
        request.source.destroy(request.signal?.reason instanceof Error ? request.signal.reason : undefined);
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      try {
        const info = await transport.sendMail({
          raw: request.source,
          envelope: { from: request.envelopeFrom ?? "", to: request.recipients },
          dsn: request.deliveryStatusNotification
            ? {
                envid: request.deliveryStatusNotification.id,
                ret: "HDRS",
                notify: ["SUCCESS", "FAILURE", "DELAY"],
              }
            : undefined,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        return {
          accepted: info.accepted.map(String),
          rejected: info.rejected.map(String),
          response: info.response ?? "",
          messageId: info.messageId || request.messageId,
        };
      } finally {
        request.signal?.removeEventListener("abort", abort);
      }
    },
    { signal: request.signal },
  );

export const assertUidValidity = (actual: string | null, expected: string): void => {
  if (!actual || actual !== expected) {
    throw Object.assign(new Error("Folder UIDVALIDITY changed"), {
      code: "UIDVALIDITY_CHANGED",
      expected,
      actual: actual || null,
    });
  }
};

type SelectedMailboxClient = Pick<ImapFlow, "usable" | "mailbox">;

// ImapFlow answers SEARCH with undefined and yields nothing from FETCH once the
// socket dropped, so an empty result is only trustworthy while the mailbox is
// still selected on a usable connection.
export const assertSelectedMailbox = (client: SelectedMailboxClient, expected: string): void => {
  if (!client.usable || !client.mailbox) {
    throw Object.assign(new Error("IMAP connection lost while the folder was selected"), { code: "IMAP_CONNECTION_LOST" });
  }
  assertUidValidity(client.mailbox.uidValidity.toString(), expected);
};

const assertSelectedUidValidity = (client: ImapFlow, expected: string): void => {
  const actual = client.mailbox && client.mailbox.uidValidity.toString();
  assertUidValidity(actual || null, expected);
};

const withSelectedMailbox = async <T>(
  config: ProviderConnectionInput,
  target: Pick<RemoteMutationTarget, "folderPath" | "uidValidity">,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> =>
  withImapClient(config, async (client) => {
    const lock = await client.getMailboxLock(target.folderPath, { readOnly: false });
    try {
      assertSelectedUidValidity(client, target.uidValidity);
      return await fn(client);
    } finally {
      lock.release();
    }
  });

const setFlags = async (config: ProviderConnectionInput, target: RemoteMutationTarget, flags: string[]): Promise<void> =>
  withSelectedMailbox(config, target, async (client) => {
    const changed = await client.messageFlagsSet(target.uid, flags, { uid: true });
    if (!changed)
      throw Object.assign(new Error("Provider did not confirm the remote flag replacement"), { code: "REMOTE_FLAGS_UNCONFIRMED" });
  });

export const assertProviderKeywordsSupported = (permanentFlags: Iterable<string> | undefined, keywords: string[]): void => {
  if (keywords.length === 0 || permanentFlags === undefined) return;
  const allowed = new Set([...permanentFlags].map((flag) => flag.toLowerCase()));
  if (allowed.has("\\*") || keywords.every((keyword) => allowed.has(keyword.toLowerCase()))) return;
  throw Object.assign(new Error("The provider does not allow custom keywords in this folder"), {
    code: "REMOTE_KEYWORDS_UNSUPPORTED",
  });
};

const changeMessageState = async (
  config: ProviderConnectionInput,
  target: RemoteMutationTarget,
  change: RemoteMessageStateChange,
): Promise<RemoteMessageState> =>
  withSelectedMailbox(config, target, async (client) => {
    assertProviderKeywordsSupported(client.mailbox ? client.mailbox.permanentFlags : undefined, change.addKeywords);
    const additions = [...new Set([...change.addFlags, ...change.addKeywords])];
    const removals = [...new Set([...change.removeFlags, ...change.removeKeywords])];
    let changedState = false;
    try {
      if (additions.length > 0) {
        const changed = await client.messageFlagsAdd(target.uid, additions, { uid: true });
        if (!changed)
          throw Object.assign(new Error("Provider did not confirm the remote state addition"), { code: "REMOTE_STATE_UNCONFIRMED" });
        changedState = true;
      }
      if (removals.length > 0) {
        const changed = await client.messageFlagsRemove(target.uid, removals, { uid: true });
        if (!changed)
          throw Object.assign(new Error("Provider did not confirm the remote state removal"), { code: "REMOTE_STATE_UNCONFIRMED" });
        changedState = true;
      }
      const message = await client.fetchOne(target.uid, { uid: true, flags: true, envelope: true }, { uid: true });
      if (!message) return { exists: false, flags: [], keywords: [], messageId: null, modseq: null };
      const state = splitRemoteFlags(message.flags ?? []);
      return {
        exists: true,
        flags: state.flags,
        keywords: state.keywords,
        messageId: message.envelope?.messageId?.trim() || null,
        modseq: message.modseq?.toString() ?? null,
      };
    } catch (cause) {
      if (!changedState) throw cause;
      throw Object.assign(new Error("Remote message state may have changed before the operation failed"), {
        code: "REMOTE_STATE_PARTIAL",
        cause,
      });
    }
  });

const mapCopyResult = (result: Awaited<ReturnType<ImapFlow["messageCopy"]>>, sourceUid: number): RemoteCopyResult => ({
  destinationUidValidity: result && result.uidValidity ? result.uidValidity.toString() : null,
  destinationUid: result && result.uidMap ? (result.uidMap.get(sourceUid) ?? null) : null,
});

const copy = async (config: ProviderConnectionInput, target: RemoteMutationTarget, destinationPath: string): Promise<RemoteCopyResult> =>
  withSelectedMailbox(config, target, async (client) => {
    const result = await client.messageCopy(target.uid, destinationPath, { uid: true });
    if (!result) throw Object.assign(new Error("Remote message copy failed"), { code: "REMOTE_COPY_FAILED" });
    return mapCopyResult(result, target.uid);
  });

const move = async (config: ProviderConnectionInput, target: RemoteMutationTarget, destinationPath: string): Promise<RemoteCopyResult> =>
  withSelectedMailbox(config, target, async (client) => {
    // MOVE, or COPY plus UID EXPUNGE through UIDPLUS. Without either the source
    // would survive the move, so there is no safe path.
    if (!capability(client, "MOVE") && !capability(client, "UIDPLUS")) {
      throw Object.assign(new Error("Provider cannot move a message without losing the source"), { code: "SAFE_MOVE_UNSUPPORTED" });
    }
    const result = await client.messageMove(target.uid, destinationPath, { uid: true });
    if (!result) throw Object.assign(new Error("Remote message move failed"), { code: "REMOTE_MOVE_FAILED" });
    return mapCopyResult(result, target.uid);
  });

const deleteMessage = async (config: ProviderConnectionInput, target: RemoteMutationTarget): Promise<void> =>
  withSelectedMailbox(config, target, async (client) => {
    if (!capability(client, "UIDPLUS")) {
      throw Object.assign(new Error("Safe delete requires UIDPLUS"), { code: "SAFE_DELETE_UNSUPPORTED" });
    }
    const deleted = await client.messageDelete(target.uid, { uid: true });
    if (!deleted) {
      throw Object.assign(new Error("Remote delete did not complete safely"), { code: "REMOTE_DELETE_FAILED" });
    }
  });

const appendSource = async (
  config: ProviderConnectionInput,
  folderPath: string,
  source: Readable,
  byteLength: number,
  flags: string[] = ["\\Seen"],
  internalDate = new Date(),
  signal?: AbortSignal,
): Promise<RemoteAppendResult> => {
  try {
    return await withImapClient(
      config,
      async (client) => {
        return appendStream({ client, path: folderPath, source, byteLength, flags, internalDate });
      },
      signal,
    );
  } catch (error) {
    if (error && typeof error === "object" && "effectPossible" in error) throw error;
    const sourceError = error instanceof Error ? error : new Error("IMAP APPEND failed before transfer");
    throw Object.assign(sourceError, { effectPossible: false });
  }
};

const normalizeMessageId = (value: string | null | undefined): string => value?.trim().toLowerCase() ?? "";

const findMessageById = async (
  config: ProviderConnectionInput,
  folderPath: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<number[]> =>
  withImapClient(
    config,
    async (client) => {
      const lock = await client.getMailboxLock(folderPath, { readOnly: true });
      try {
        const matches = await client.search({ header: { "message-id": messageId } }, { uid: true });
        if (!matches || matches.length === 0) return [];
        const expected = normalizeMessageId(messageId);
        const exact: number[] = [];
        for (const uid of matches.slice(-100)) {
          const message = await client.fetchOne(uid, { uid: true, envelope: true }, { uid: true });
          if (message && normalizeMessageId(message.envelope?.messageId) === expected) exact.push(uid);
        }
        return exact.sort((left, right) => left - right);
      } finally {
        lock.release();
      }
    },
    signal,
  );

const getMessageState = async (config: ProviderConnectionInput, target: RemoteMutationTarget): Promise<RemoteMessageState> =>
  withSelectedMailbox(config, target, async (client) => {
    const message = await client.fetchOne(target.uid, { uid: true, flags: true, envelope: true }, { uid: true });
    const state = message ? splitRemoteFlags(message.flags ?? []) : { flags: [], keywords: [] };
    return message
      ? {
          exists: true,
          flags: state.flags,
          keywords: state.keywords,
          messageId: message.envelope?.messageId?.trim() || null,
          modseq: message.modseq?.toString() ?? null,
        }
      : { exists: false, flags: [], keywords: [], messageId: null, modseq: null };
  });

const createFolder = async (config: ProviderConnectionInput, path: string, subscribe: boolean): Promise<void> =>
  withImapClient(config, async (client) => {
    await client.mailboxCreate(path);
    if (subscribe && !(await client.mailboxSubscribe(path))) {
      throw Object.assign(new Error("Remote folder was created but could not be subscribed"), {
        code: "REMOTE_CREATE_SUBSCRIBE_PARTIAL",
      });
    }
  });

type RenameFolderClient = Pick<ImapFlow, "list" | "mailboxRename" | "mailboxSubscribe">;

const sameMailboxPath = (left: string, right: string): boolean =>
  left === right || (left.toUpperCase() === "INBOX" && right.toUpperCase() === "INBOX");

export const renameImapFolder = async (client: RenameFolderClient, path: string, newPath: string): Promise<void> => {
  const current = (await client.list()).find((folder) => sameMailboxPath(folder.path, path));
  if (!current) {
    throw Object.assign(new Error("Remote folder does not exist"), { code: "REMOTE_FOLDER_NOT_FOUND" });
  }

  await client.mailboxRename(path, newPath);
  if (current.subscribed && !(await client.mailboxSubscribe(newPath))) {
    throw Object.assign(new Error("Remote folder was renamed but its subscription could not be restored"), {
      code: "REMOTE_RENAME_SUBSCRIBE_PARTIAL",
    });
  }
};

const renameFolder = async (config: ProviderConnectionInput, path: string, newPath: string): Promise<void> =>
  withImapClient(config, async (client) => {
    await renameImapFolder(client, path, newPath);
  });

const deleteFolder = async (config: ProviderConnectionInput, path: string): Promise<void> =>
  withImapClient(config, async (client) => {
    await client.mailboxDelete(path);
  });

const setFolderSubscription = async (config: ProviderConnectionInput, path: string, subscribed: boolean): Promise<void> =>
  withImapClient(config, async (client) => {
    const changed = subscribed ? await client.mailboxSubscribe(path) : await client.mailboxUnsubscribe(path);
    if (!changed) {
      throw Object.assign(new Error("Provider did not confirm the remote folder subscription"), {
        code: "REMOTE_SUBSCRIPTION_UNCONFIRMED",
      });
    }
  });

const listenForChanges = async (
  config: ProviderConnectionInput,
  request: ConnectorChangeListenerRequest,
): Promise<ConnectorChangeListener> => {
  const endpoint = await resolvePublicEndpoint(config.imap);
  const client = createImapClient(config, endpoint);
  try {
    await client.connect();
    return await openImapChangeListener(client, request);
  } catch (error) {
    client.close();
    throw error;
  }
};

export const imapSmtpConnector: MailConnector = {
  verify,
  verifySmtp: verifySmtpTransport,
  discoverLimits,
  discoverFolders,
  getFolderStatus,
  fetchEnvelopeBatch,
  fetchFlagChanges,
  fetchUidWindow,
  downloadSourceBatch,
  send,
  sendSource,
  setFlags,
  changeMessageState,
  copy,
  move,
  delete: deleteMessage,
  appendSource,
  findMessageById,
  getMessageState,
  createFolder,
  renameFolder,
  deleteFolder,
  setFolderSubscription,
  listenForChanges,
};
