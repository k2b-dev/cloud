import type { AppRegistryEntry } from "../contracts/registry";

export type RuntimeCompatibilityIssue = {
  code: "invalid-sync-version" | "mixed-sync-generation" | "mixed-sync-version";
  severity: "warn" | "error";
  message: string;
  appIds: string[];
};

type ParsedVersion = { major: number; minor: number; patch: number };

const parseVersion = (value: string): ParsedVersion | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

/** @k2b/sync 6 moved from Redis to NATS; a 5.x process cannot see 6.x registrations or durable work. */
const isLegacyGeneration = (version: ParsedVersion): boolean => version.major < 6;

export const assessRuntimeCompatibility = (apps: readonly AppRegistryEntry[]): RuntimeCompatibilityIssue[] => {
  const issues: RuntimeCompatibilityIssue[] = [];
  const known: Array<{ id: string; version: string; parsed: ParsedVersion }> = [];

  for (const app of apps) {
    const version = app.runtime?.syncVersion;
    if (!version || version === "unknown") continue;
    const parsed = parseVersion(version);
    if (!parsed) {
      issues.push({
        code: "invalid-sync-version",
        severity: "warn",
        message: `App reports invalid @k2b/sync version ${JSON.stringify(version)}.`,
        appIds: [app.id],
      });
      continue;
    }
    known.push({ id: app.id, version, parsed });
  }

  const legacy = known.filter(({ parsed }) => isLegacyGeneration(parsed));
  const current = known.filter(({ parsed }) => !isLegacyGeneration(parsed));
  if (legacy.length > 0 && current.length > 0) {
    issues.push({
      code: "mixed-sync-generation",
      severity: "error",
      message: "Mixed @k2b/sync 5.x (Redis) and 6.x (NATS) runtimes cannot see each other's registrations or durable work.",
      appIds: [...legacy, ...current].map(({ id }) => id),
    });
    return issues;
  }

  const versions = [...new Set(known.map(({ version }) => version))];
  if (versions.length > 1) {
    issues.push({
      code: "mixed-sync-version",
      severity: "warn",
      message: `Mixed @k2b/sync versions are running (${versions.sort().join(", ")}).`,
      appIds: known.map(({ id }) => id),
    });
  }

  return issues;
};
