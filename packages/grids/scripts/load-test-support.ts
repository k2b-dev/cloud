import { z } from "zod";

export const LOAD_FIXTURE_MARKER = "grids-local-load-fixture";
export const LOAD_MANIFEST_VERSION = 3;

const UuidSchema = z.string().uuid();
const ShortIdSchema = z.string().regex(/^[A-Za-z0-9]{6}$/);

export const LOAD_SHORT_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LOAD_SHORT_ID_SPACE = LOAD_SHORT_ID_ALPHABET.length ** 6;

const loadShortIdOrdinal = (shortId: string): number => {
  if (!ShortIdSchema.safeParse(shortId).success) throw new Error(`invalid load-test Record ID: ${shortId}`);
  let ordinal = 0;
  for (const character of shortId) {
    ordinal = ordinal * LOAD_SHORT_ID_ALPHABET.length + LOAD_SHORT_ID_ALPHABET.indexOf(character);
  }
  return ordinal;
};

export const loadRecordShortId = (ordinal: number): string => {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= LOAD_SHORT_ID_SPACE) {
    throw new Error(`load-test Record ID ordinal must be between 0 and ${LOAD_SHORT_ID_SPACE - 1}`);
  }
  let remaining = ordinal;
  let shortId = "";
  for (let power = 5; power >= 0; power--) {
    const divisor = LOAD_SHORT_ID_ALPHABET.length ** power;
    const digit = Math.floor(remaining / divisor);
    shortId += LOAD_SHORT_ID_ALPHABET[digit];
    remaining %= divisor;
  }
  return shortId;
};

export const reserveLoadRecordShortIds = (existingShortIds: string[], count: number): number => {
  if (!Number.isSafeInteger(count) || count <= 0 || count > LOAD_SHORT_ID_SPACE) {
    throw new Error(`load-test Record count must be between 1 and ${LOAD_SHORT_ID_SPACE}`);
  }
  const occupied = [...new Set(existingShortIds.map(loadShortIdOrdinal))].sort((a, b) => a - b);
  let start = 0;
  for (const ordinal of occupied) {
    if (ordinal < start) continue;
    if (ordinal - start >= count) return start;
    start = ordinal + 1;
  }
  if (LOAD_SHORT_ID_SPACE - start >= count) return start;
  throw new Error(`No contiguous public Record ID range is available for ${count} load-test Records`);
};

export const LoadManifestSchema = z.object({
  version: z.literal(LOAD_MANIFEST_VERSION),
  marker: z.literal(LOAD_FIXTURE_MARKER),
  createdAt: z.string().datetime(),
  baseUrl: z.string().url(),
  baseId: ShortIdSchema,
  baseName: z.string().min(1),
  rows: z.number().int().positive(),
  recordIdPrefix: z.string().regex(/^[0-9a-f]{8}$/),
  recordShortIdStart: z.number().int().nonnegative(),
  serviceAccountId: UuidSchema,
  credentialId: UuidSchema,
  accessId: UuidSchema,
  apiToken: z.string().min(1),
  sessionToken: z.string().min(1),
  tables: z.object({
    items: ShortIdSchema,
    categories: ShortIdSchema,
    locations: ShortIdSchema,
  }),
  fields: z.object({
    assetId: ShortIdSchema,
    name: ShortIdSchema,
    category: ShortIdSchema,
    location: ShortIdSchema,
    status: ShortIdSchema,
    condition: ShortIdSchema,
    serialNumber: ShortIdSchema,
    tags: ShortIdSchema,
    quantity: ShortIdSchema,
    replacementValue: ShortIdSchema,
    purchaseDate: ShortIdSchema,
    notes: ShortIdSchema,
  }),
  workflowId: ShortIdSchema,
  documentTemplateId: ShortIdSchema.optional(),
  documentRecordId: ShortIdSchema,
  internal: z.object({
    baseId: UuidSchema,
    tables: z.object({ items: UuidSchema, categories: UuidSchema, locations: UuidSchema }),
    fields: z.object({
      assetId: UuidSchema,
      name: UuidSchema,
      category: UuidSchema,
      location: UuidSchema,
      status: UuidSchema,
      condition: UuidSchema,
      serialNumber: UuidSchema,
      tags: UuidSchema,
      quantity: UuidSchema,
      replacementValue: UuidSchema,
      purchaseDate: UuidSchema,
      notes: UuidSchema,
    }),
    workflowId: UuidSchema,
  }),
});

export type LoadManifest = z.infer<typeof LoadManifestSchema>;
export type LoadProfile = "load" | "smoke" | "soak" | "stress";

export const LOAD_PROFILES: readonly LoadProfile[] = ["smoke", "load", "soak", "stress"];

export const parsePositiveInteger = (value: string | undefined, fallback: number, label: string): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
};

export const parseProfile = (value: string | undefined): LoadProfile => {
  if (value && LOAD_PROFILES.includes(value as LoadProfile)) return value as LoadProfile;
  throw new Error(`profile must be one of: ${LOAD_PROFILES.join(", ")}`);
};

export const deterministicRecordId = (prefix: string, index: number): string => {
  if (!/^[0-9a-f]{8}$/i.test(prefix)) throw new Error("record prefix must contain eight hexadecimal characters");
  if (!Number.isSafeInteger(index) || index < 1 || index > 0xffffffffffff) {
    throw new Error("record index must be an integer between 1 and 281474976710655");
  }
  return `${prefix.toLowerCase()}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
};

type MetricValues = Record<string, number | undefined>;

export type K6Summary = {
  metrics?: Record<string, { values?: MetricValues }>;
  state?: { testRunDurationMs?: number };
};

export type LoadHealthSnapshot = {
  capturedAt: string;
  operational: {
    status: "error" | "ok" | "warn";
    outbox: { dead: number; failed: number; pending: number };
    workflows: { needsAttention: number; staleRunning: number };
    effects: { needsAttention: number };
  };
  postgres: {
    activeConnections: number;
    databaseBytes: number;
    idleConnections: number;
    maxConnections: number;
    totalConnections: number;
  };
  fixture: {
    workflowActive: number;
    workflowFailed: number;
    recordEventsPending: number;
    recordEventsFailed: number;
    recordEventsDead: number;
  };
  containers: Array<{
    name: string;
    cpu: string;
    memory: string;
    memoryBytes: number;
    memoryLimitBytes: number;
  }>;
};

export type LoadReport = {
  profile: LoadProfile;
  k6ExitCode: number;
  rows: number;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  requests: number;
  requestsPerSecond: number;
  failedRequestRate: number;
  businessErrorRate: number;
  rateLimitedRequests: number;
  ingressRateLimitedRequests: number;
  queryOverloadedRequests: number;
  checksRate: number;
  p95Ms: number;
  p99Ms: number;
  before: LoadHealthSnapshot;
  after: LoadHealthSnapshot;
  gates: Array<{ name: string; passed: boolean; detail: string }>;
  passed: boolean;
};

const metric = (summary: K6Summary, name: string, key: string): number => summary.metrics?.[name]?.values?.[key] ?? 0;

export const buildLoadReport = (input: {
  profile: LoadProfile;
  k6ExitCode: number;
  rows: number;
  startedAt: string;
  finishedAt: string;
  summary: K6Summary;
  before: LoadHealthSnapshot;
  after: LoadHealthSnapshot;
}): LoadReport => {
  const requests = metric(input.summary, "http_reqs", "count");
  const durationSeconds = Math.max(0, (input.summary.state?.testRunDurationMs ?? 0) / 1_000);
  const failedRequestRate = metric(input.summary, "http_req_failed", "rate");
  const businessErrorRate = metric(input.summary, "business_errors", "rate");
  const rateLimitedRequests = metric(input.summary, "rate_limited_requests", "count");
  const ingressRateLimitedRequests = metric(input.summary, "ingress_rate_limited_requests", "count");
  const queryOverloadedRequests = metric(input.summary, "query_overloaded_requests", "count");
  const checksRate = metric(input.summary, "checks", "rate");
  const p95Ms = metric(input.summary, "http_req_duration", "p(95)");
  const p99Ms = metric(input.summary, "http_req_duration", "p(99)");
  const deltas = {
    dead: input.after.operational.outbox.dead - input.before.operational.outbox.dead,
    workflowAttention: input.after.operational.workflows.needsAttention - input.before.operational.workflows.needsAttention,
    staleRuns: input.after.operational.workflows.staleRunning - input.before.operational.workflows.staleRunning,
    effectAttention: input.after.operational.effects.needsAttention - input.before.operational.effects.needsAttention,
    postgresConnections: input.after.postgres.totalConnections - input.before.postgres.totalConnections,
  };
  const postgresUtilization = input.after.postgres.totalConnections / Math.max(1, input.after.postgres.maxConnections);
  const beforeContainers = new Map(input.before.containers.map((container) => [container.name, container]));
  const containerMemorySafe = input.after.containers.every(
    (container) => container.memoryBytes / Math.max(1, container.memoryLimitBytes) < 0.85,
  );
  const containerMemoryStable = input.after.containers.every((container) => {
    const before = beforeContainers.get(container.name);
    if (!before) return true;
    return container.memoryBytes - before.memoryBytes <= Math.max(256 * 1024 * 1024, before.memoryBytes * 0.5);
  });
  const latencyLimit =
    input.profile === "stress"
      ? { p95: 3_000, p99: 6_000 }
      : input.profile === "load" || input.profile === "soak"
        ? { p95: 250, p99: 500 }
        : { p95: 1_500, p99: 3_000 };
  const gates = [
    { name: "k6 process", passed: input.k6ExitCode === 0, detail: `exit code ${input.k6ExitCode}` },
    { name: "HTTP failures", passed: failedRequestRate < 0.01, detail: `${(failedRequestRate * 100).toFixed(2)}% < 1.00%` },
    { name: "Business errors", passed: businessErrorRate < 0.01, detail: `${(businessErrorRate * 100).toFixed(2)}% < 1.00%` },
    { name: "Checks", passed: checksRate > 0.99, detail: `${(checksRate * 100).toFixed(2)}% > 99.00%` },
    { name: "p95 latency", passed: p95Ms < latencyLimit.p95, detail: `${p95Ms.toFixed(0)}ms < ${latencyLimit.p95}ms` },
    { name: "p99 latency", passed: p99Ms < latencyLimit.p99, detail: `${p99Ms.toFixed(0)}ms < ${latencyLimit.p99}ms` },
    { name: "Dead record events", passed: deltas.dead <= 0, detail: `delta ${deltas.dead}` },
    { name: "Workflow attention", passed: deltas.workflowAttention <= 0, detail: `delta ${deltas.workflowAttention}` },
    { name: "Stale workflow runs", passed: deltas.staleRuns <= 0, detail: `delta ${deltas.staleRuns}` },
    { name: "Effect attention", passed: deltas.effectAttention <= 0, detail: `delta ${deltas.effectAttention}` },
    {
      name: "Postgres connection capacity",
      passed: postgresUtilization < 0.9,
      detail: `${(postgresUtilization * 100).toFixed(1)}% < 90.0%`,
    },
    {
      name: "Postgres connection growth",
      passed: deltas.postgresConnections <= 20,
      detail: `delta ${deltas.postgresConnections} <= 20`,
    },
    {
      name: "Container memory capacity",
      passed: containerMemorySafe,
      detail: containerMemorySafe ? "all below 85%" : "at least one at 85% or above",
    },
    {
      name: "Container memory growth",
      passed: containerMemoryStable,
      detail: containerMemoryStable ? "within baseline allowance" : "growth exceeded 256 MiB or 50%",
    },
    {
      name: "Fixture workflow completion",
      passed: input.after.fixture.workflowActive === 0 && input.after.fixture.workflowFailed === 0,
      detail: `${input.after.fixture.workflowActive} active, ${input.after.fixture.workflowFailed} failed`,
    },
    {
      name: "Fixture record event delivery",
      passed:
        input.after.fixture.recordEventsPending === 0 &&
        input.after.fixture.recordEventsFailed === 0 &&
        input.after.fixture.recordEventsDead === 0,
      detail: `${input.after.fixture.recordEventsPending} pending, ${input.after.fixture.recordEventsFailed} failed, ${input.after.fixture.recordEventsDead} dead`,
    },
  ];
  return {
    profile: input.profile,
    k6ExitCode: input.k6ExitCode,
    rows: input.rows,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationSeconds,
    requests,
    requestsPerSecond: durationSeconds > 0 ? requests / durationSeconds : 0,
    failedRequestRate,
    businessErrorRate,
    rateLimitedRequests,
    ingressRateLimitedRequests,
    queryOverloadedRequests,
    checksRate,
    p95Ms,
    p99Ms,
    before: input.before,
    after: input.after,
    gates,
    passed: gates.every((gate) => gate.passed),
  };
};

export const renderLoadReport = (report: LoadReport): string => {
  const gateRows = report.gates.map((gate) => `| ${gate.passed ? "PASS" : "FAIL"} | ${gate.name} | ${gate.detail} |`).join("\n");
  const containerRows = report.after.containers.length
    ? report.after.containers.map((container) => `| ${container.name} | ${container.cpu} | ${container.memory} |`).join("\n")
    : "| n/a | n/a | n/a |";
  return `# Grids ${report.profile} report

- Result: **${report.passed ? "PASS" : "FAIL"}**
- Fixture rows: ${report.rows.toLocaleString("en-US")}
- Window: ${report.startedAt} to ${report.finishedAt}
- Requests: ${report.requests.toLocaleString("en-US")} (${report.requestsPerSecond.toFixed(1)}/s)
- Ingress rate limited (429): ${report.ingressRateLimitedRequests.toLocaleString("en-US")}
- Query admission rejected (503): ${report.queryOverloadedRequests.toLocaleString("en-US")}
- Latency: p95 ${report.p95Ms.toFixed(0)}ms, p99 ${report.p99Ms.toFixed(0)}ms

## Gates

| Result | Gate | Observation |
| --- | --- | --- |
${gateRows}

## Postgres after run

- Connections: ${report.after.postgres.totalConnections}/${report.after.postgres.maxConnections} total, ${report.after.postgres.activeConnections} active, ${report.after.postgres.idleConnections} idle
- Database size: ${(report.after.postgres.databaseBytes / 1024 / 1024).toFixed(1)} MiB
- Grids health: ${report.after.operational.status}
- Fixture workflow runs: ${report.after.fixture.workflowActive} active, ${report.after.fixture.workflowFailed} failed
- Fixture record events: ${report.after.fixture.recordEventsPending} pending, ${report.after.fixture.recordEventsFailed} failed, ${report.after.fixture.recordEventsDead} dead

## Containers after run

| Container | CPU | Memory |
| --- | --- | --- |
${containerRows}
`;
};
