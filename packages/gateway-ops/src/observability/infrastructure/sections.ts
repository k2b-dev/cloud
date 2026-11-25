/**
 * The infrastructure overview's sections, one per backend. The SSR page and the section API build them here, so the
 * first picture and a section that loads later show the same thing.
 */
import { formatBytes, formatNumber, formatPercent } from "@k2b/cloud/shared";
import { gatewayOpsMessages } from "../../messages";
import type { KeyCell } from "../_components/KeyCells";
import { getPostgresDiagnostics, getRedisDiagnostics, type PostgresDiagnostics, type RedisDiagnostics } from "../data/service";
import { NatsQuerySchema, readNatsDiagnostics } from "../nats/diagnostics";
import { natsMessages } from "../nats/messages";

export const INFRASTRUCTURE_BACKENDS = ["postgres", "valkey", "nats"] as const;
export type InfrastructureBackend = (typeof INFRASTRUCTURE_BACKENDS)[number];
export const isInfrastructureBackend = (value: string): value is InfrastructureBackend =>
  (INFRASTRUCTURE_BACKENDS as readonly string[]).includes(value);

export type InfraNotice = { tone: "warn" | "bad" | "note"; title: string; text: string };
/** One backend in the overview: its state in one word, its key numbers and what needs attention. */
export type InfraSection = { status: "ok" | "warn" | "bad"; cells: KeyCell[]; notices: InfraNotice[] };

/**
 * How long the overview's first picture waits for one backend: a fifth of the 5 s observability read budget. A backend
 * that answers later loads on its own in its section, so a slow backend never holds the others back.
 */
export const INFRA_SECTION_SSR_BUDGET_MS = 1_000;

const statusOf = (notices: InfraNotice[]): InfraSection["status"] =>
  notices.some((notice) => notice.tone === "bad") ? "bad" : notices.some((notice) => notice.tone === "warn") ? "warn" : "ok";

const warnings = (list: PostgresDiagnostics["warnings"]): InfraNotice[] =>
  list.map((warning) => ({ tone: warning.tone === "red" ? "bad" : "warn", title: warning.title, text: warning.detail }));

/** Postgres key numbers; the Postgres tab shows them too. */
export const postgresCells = (diagnostics: PostgresDiagnostics, locale: string): KeyCell[] => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const number = (value: number) => formatNumber(value, { locale });
  const runtime = diagnostics.runtime;
  const critical = diagnostics.warnings.some((warning) => warning.tone === "red");
  return [
    {
      icon: "database",
      label: t.storage,
      value: formatBytes(diagnostics.totalBytes, { locale }),
      meta: t.tablesCount({ count: number(diagnostics.tables) }),
      tone: diagnostics.available ? undefined : "bad",
    },
    {
      icon: "plug-connected",
      label: t.connections,
      value: `${number(runtime.connections)}/${number(runtime.maxConnections)}`,
      meta: t.activeCount({ count: number(runtime.activeConnections) }),
      tone: runtime.maxConnections > 0 && runtime.connections / runtime.maxConnections >= 0.8 ? "warn" : undefined,
    },
    {
      icon: "lock",
      label: t.lockWaits,
      value: number(runtime.waitingLocks),
      meta: runtime.waitingLocks ? t.oldestQuerySeconds({ seconds: Math.round(runtime.oldestWaitingQuerySeconds) }) : t.none,
      tone: runtime.waitingLocks ? "warn" : undefined,
    },
    {
      icon: critical ? "alert-circle" : "alert-triangle",
      label: t.warnings,
      value: number(diagnostics.warnings.length),
      meta: diagnostics.warnings.length ? t.needsReview : t.none,
      tone: critical ? "bad" : diagnostics.warnings.length ? "warn" : undefined,
    },
  ];
};

/** Valkey key numbers; the Valkey tab shows them too. */
export const valkeyCells = (diagnostics: RedisDiagnostics, locale: string): KeyCell[] => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const number = (value: number) => formatNumber(value, { locale });
  const runtime = diagnostics.runtime;
  const memoryPressure =
    runtime.usedMemoryBytes !== null && runtime.maxMemoryBytes !== null && runtime.maxMemoryBytes > 0
      ? runtime.usedMemoryBytes / runtime.maxMemoryBytes > 0.85
      : false;
  const expiringKeys = diagnostics.keyspace.reduce((sum, row) => sum + row.expires, 0);
  return [
    { icon: "key", label: t.keys, value: number(diagnostics.dbSize), meta: t.expiringKeys({ count: number(expiringKeys) }) },
    {
      icon: "cpu",
      label: t.memory,
      value: runtime.usedMemoryBytes === null ? "—" : formatBytes(runtime.usedMemoryBytes, { locale }),
      meta:
        runtime.maxMemoryBytes && runtime.maxMemoryBytes > 0
          ? t.ofValue({ value: formatBytes(runtime.maxMemoryBytes, { locale }) })
          : runtime.usedMemoryBytes === null
            ? t.unavailable
            : t.noMaxMemory,
      tone: memoryPressure ? "warn" : undefined,
    },
    {
      icon: "trash-x",
      label: t.evicted,
      value: runtime.evictedKeys === null ? "—" : number(runtime.evictedKeys),
      meta: runtime.maxMemoryPolicy ?? t.policyUnknown,
      tone: (runtime.evictedKeys ?? 0) > 0 ? "bad" : undefined,
    },
    {
      icon: "target-arrow",
      label: t.hitRate,
      value: runtime.hitRate === null ? "—" : formatPercent(runtime.hitRate, { locale }),
      meta: runtime.connectedClients === null ? t.clientsUnknown : t.clientCount({ count: number(runtime.connectedClients) }),
      tone: runtime.hitRate !== null && runtime.hitRate < 0.8 ? "warn" : undefined,
    },
  ];
};

const postgresSection = async (locale: string): Promise<InfraSection> => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const diagnostics = await getPostgresDiagnostics(locale);
  const notices: InfraNotice[] = [
    ...(diagnostics.available ? [] : [{ tone: "bad" as const, title: t.unavailable, text: t.postgresDescription }]),
    ...warnings(diagnostics.warnings),
  ];
  return { status: statusOf(notices), cells: postgresCells(diagnostics, locale), notices };
};

const valkeySection = async (locale: string): Promise<InfraSection> => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const diagnostics = await getRedisDiagnostics(locale);
  const notices: InfraNotice[] = [
    ...(diagnostics.available ? [] : [{ tone: "bad" as const, title: t.unavailable, text: diagnostics.error ?? t.redisDescription }]),
    ...warnings(diagnostics.warnings),
  ];
  return { status: statusOf(notices), cells: valkeyCells(diagnostics, locale), notices };
};

const natsSection = async (locale: string): Promise<InfraSection> => {
  const { t } = natsMessages.resolve([locale]);
  const { cluster, inventory } = await readNatsDiagnostics(NatsQuerySchema.parse({}));
  const count = (value: number | null) => (value === null ? t.unknown : formatNumber(value, { locale }));
  const known = (value: number | null) => (inventory.accountTotal === null ? null : value);
  const notices: InfraNotice[] = [
    ...(cluster.status === "not_configured"
      ? [{ tone: "note" as const, title: t.cluster, text: cluster.accessRequired ? t.accessEndpointHelp : t.notConfigured }]
      : cluster.status !== "available"
        ? [{ tone: "warn" as const, title: cluster.status === "partial" ? t.partial : t.unavailable, text: t.clusterIssue }]
        : []),
    ...(inventory.status !== "available"
      ? [
          {
            tone: "warn" as const,
            title: inventory.status === "partial" ? t.partial : t.unavailable,
            text: inventory.status === "not_configured" ? t.inventoryMissing : t.inventoryIssue,
          },
        ]
      : []),
  ];
  const problems = known(inventory.summary.problemStreams) ?? 0;
  return {
    status: problems > 0 && statusOf(notices) === "ok" ? "warn" : statusOf(notices),
    cells: [
      {
        icon: "server",
        label: t.cluster,
        value: count(cluster.nodes.length),
        meta: cluster.status === "available" ? t.available : t.unknown,
      },
      { icon: "database", label: t.streams, value: count(known(inventory.total)) },
      {
        icon: "alert-triangle",
        label: t.problemStreams,
        value: count(known(inventory.summary.problemStreams)),
        tone: problems > 0 ? "warn" : undefined,
      },
      {
        icon: "mail-x",
        label: t.deadLetterStreams,
        value: count(known(inventory.summary.deadLetterStreams)),
        tone: (known(inventory.summary.deadLetterStreams) ?? 0) > 0 ? "warn" : undefined,
      },
    ],
    notices,
  };
};

const BUILDERS: Record<InfrastructureBackend, (locale: string) => Promise<InfraSection>> = {
  postgres: postgresSection,
  valkey: valkeySection,
  nats: natsSection,
};

/** One backend's section. Throws when the backend cannot be read at all; the caller shows that in the section. */
export const readInfraSection = (backend: InfrastructureBackend, locale: string) => BUILDERS[backend](locale);

/** A section within the first picture's budget, or `pending` when the backend answers later, or `failed`. */
export type InfraSectionResult = { state: "ready"; section: InfraSection } | { state: "pending" } | { state: "failed"; message: string };

export const readInfraSectionWithin = async (
  backend: InfrastructureBackend,
  locale: string,
  budgetMs = INFRA_SECTION_SSR_BUDGET_MS,
): Promise<InfraSectionResult> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<InfraSectionResult>((done) => {
    timer = setTimeout(() => done({ state: "pending" }), budgetMs);
  });
  const read = readInfraSection(backend, locale).then(
    (section): InfraSectionResult => ({ state: "ready", section }),
    (error: unknown): InfraSectionResult => ({ state: "failed", message: error instanceof Error ? error.message : String(error) }),
  );
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
};
