/**
 * Generates `.env.example`, `.env.prod.example` and the configuration
 * reference from the environment registries: `packages/cloud/src/config/env.ts`,
 * every `packages/<app>/src/env.ts` and the Cloud Login server's `pwas/pwa-auth/server/env.ts`.
 *
 *   bun scripts/generate-config-docs.ts          write the three files
 *   bun scripts/generate-config-docs.ts --check  exit 1 when they are stale
 */
import { Glob } from "bun";
import { z } from "zod";
import { type EnvScope, type EnvSpec, type EnvSpecs, envBoolean, envList, envString } from "../packages/cloud/src/config/define-env";
import { env } from "../packages/cloud/src/config/env";

const root = new URL("..", import.meta.url).pathname;
const check = process.argv.includes("--check");

type Registry = { name: string; source: string; specs: EnvSpecs };

const registrySchema = z.object({
  appEnv: z.object({
    $specs: z.record(
      z.string(),
      z.custom<EnvSpec<unknown>>((value) => typeof value === "object" && value !== null),
    ),
  }),
});

const loadRegistries = async (): Promise<Registry[]> => {
  const registries: Registry[] = [{ name: "Platform", source: "packages/cloud/src/config/env.ts", specs: env.$specs }];
  const paths = [
    ...new Glob("packages/*/src/env.ts").scanSync({ cwd: root }),
    ...new Glob("pwas/*/server/env.ts").scanSync({ cwd: root }),
  ].sort();
  for (const path of paths) {
    if (path.startsWith("packages/cloud/")) continue;
    const parsed = registrySchema.safeParse(await import(`${root}${path}`));
    if (!parsed.success) throw new Error(`${path} must export \`appEnv = defineEnv({...})\``);
    registries.push({ name: path.split("/")[1]!, source: path, specs: parsed.data.appEnv.$specs });
  }
  const seen = new Map<string, string>();
  for (const registry of registries) {
    for (const key of Object.keys(registry.specs)) {
      const owner = seen.get(key);
      if (owner) throw new Error(`${key} is declared in both ${owner} and ${registry.source}`);
      seen.set(key, registry.source);
    }
  }
  return registries;
};

/** Values the compose files interpolate that no Cloud process reads; `optional` entries stay commented in `.env.example`. */
const composeInputs: Record<string, { value: string; doc: string; optional?: true }> = {
  CLOUD_IMAGE_TAG: { value: "sha-0123456789ab", doc: "Immutable image tag from a successful full Docker release-set job." },
  POSTGRES_USER: {
    value: "cloud",
    doc: "Postgres user for every app's DATABASE_URL and the postgres service you define alongside the compose file.",
  },
  POSTGRES_PASSWORD: { value: "change-me", doc: "Postgres password for the same connection." },
  POSTGRES_DB: { value: "cloud", doc: "Postgres database name for the same connection." },
  CLOUD_HOST: { value: "cloud.example.com", doc: "Public hostname routed by Traefik to the gateway; also forms APP_URL." },
  CLOUD_MAIL_APP_CREDENTIAL: { value: "", doc: "Mail only: Compose passes this workload credential to Mail as CLOUD_APP_CREDENTIAL." },
  CLOUD_DEV_POSTGRES_PORT: {
    value: "5432",
    doc: "Development only: loopback host port for Postgres; host-run processes and CLOUD_TEST_DATABASE_URL must use the same port.",
    optional: true,
  },
  CLOUD_DEV_VALKEY_PORT: {
    value: "6379",
    doc: "Development only: loopback host port for Valkey; host-run processes and CLOUD_TEST_VALKEY_URL must use the same port.",
    optional: true,
  },
  CLOUD_DEV_NATS_PORT: {
    value: "4222",
    doc: "Development only: loopback host port for NATS; host-run processes and CLOUD_TEST_NATS_SERVERS must use the same port.",
    optional: true,
  },
};

const composeKeys = async (file: string): Promise<string[]> =>
  [...new Set([...(await Bun.file(`${root}${file}`).text()).matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]!))].sort();

const scope = (spec: EnvSpec<unknown>): EnvScope => spec.scope ?? "runtime";

const typeLabel = (schema: z.ZodType<unknown, unknown>): string => {
  if (schema === envString) return "string";
  if (schema === envList) return "list";
  if (schema === envBoolean) return "boolean";
  if (schema instanceof z.ZodEnum) return Object.keys(schema.enum).join(" \\| ");
  if (schema instanceof z.ZodPipe) return typeLabel(schema.in);
  return schema.def.type;
};

const defaultLabel = (spec: EnvSpec<unknown>): string => {
  if (spec.default === undefined) return "unset";
  const value = typeof spec.default === "function" ? "computed" : spec.default;
  if (Array.isArray(value) && value.length === 0) return "empty list";
  if (value === "") return "empty";
  return `\`${String(value)}\``;
};

const comment = (text: string) =>
  text
    .split("\n")
    .map((line) => `# ${line}`)
    .join("\n");

const envLine = (key: string, spec: EnvSpec<unknown>, value: string | undefined, active: boolean): string => {
  const doc = spec.aliases?.length ? `${spec.doc} Aliases: ${spec.aliases.join(", ")}.` : spec.doc;
  return `${comment(doc)}\n${active ? "" : "# "}${key}=${value ?? ""}`;
};

const developmentEnv = (registries: Registry[], interpolated: string[]): string => {
  const sections = registries.map((registry) => {
    const lines = Object.entries(registry.specs).map(([key, spec]) =>
      envLine(key, spec, spec.example, Boolean(spec.required || spec.example !== undefined)),
    );
    return `# ${"=".repeat(70)}\n# ${registry.name} (${registry.source})\n# ${"=".repeat(70)}\n\n${lines.join("\n\n")}`;
  });
  const declared = new Set(registries.flatMap((registry) => Object.keys(registry.specs)));
  const compose = interpolated
    .filter((key) => !declared.has(key))
    .map((key) => {
      const input = composeInputs[key];
      if (!input) throw new Error(`a development compose file interpolates ${key}, which no registry or compose input documents`);
      return envLine(key, { schema: envString, doc: input.doc }, input.value, !input.optional);
    });
  return `${[
    "# Generated by `bun scripts/generate-config-docs.ts` from the environment registries. Do not edit by hand.",
    "#",
    "# Host-run development reference: select variables for each process separately.",
    "# Do not load this entire file into every app: only Core receives the identity",
    "# KEKs. Only Core and OAuth receive the OAuth broker secret; background apps",
    "# receive only their own workload credential.",
    "# The Docker development stack already provides its local defaults in",
    "# compose.dev.yml and does not require copying this file to .env.",
    "# Empty values are treated as unset. Commented keys are optional.",
    "",
    ...sections,
    "",
    `# ${"=".repeat(70)}`,
    "# Docker Compose inputs (interpolated by compose files, not read by Cloud processes)",
    `# ${"=".repeat(70)}`,
    "",
    compose.join("\n\n"),
  ].join("\n")}\n`;
};

const productionEnv = (registries: Registry[], interpolated: string[]): string => {
  const specs = new Map(registries.flatMap((registry) => Object.entries(registry.specs)));
  const inputs: string[] = [];
  const secrets: string[] = [];
  const optional: string[] = [];
  for (const key of interpolated) {
    const spec = specs.get(key);
    if (!spec) {
      const input = composeInputs[key];
      if (!input) throw new Error(`compose.prod.yml interpolates ${key}, which no registry or compose input documents`);
      inputs.push(`${comment(input.doc)}\n${key}=${input.value}`);
      continue;
    }
    if (scope(spec) === "development") throw new Error(`compose.prod.yml interpolates development-only ${key}`);
    if (scope(spec) === "secret") secrets.push(envLine(key, spec, "", true));
    else optional.push(envLine(key, spec, "", false));
  }
  return `${[
    "# Generated by `bun scripts/generate-config-docs.ts` from the environment registries. Do not edit by hand.",
    "# Companion file to compose.prod.yml. Copy to .env and fill in.",
    "# compose.prod.yml wires infrastructure connections itself; only the values",
    "# below are read from this file. Empty values are treated as unset.",
    "",
    "# Compose inputs",
    "",
    inputs.join("\n\n"),
    "",
    "# Secrets",
    "",
    secrets.join("\n\n"),
    "",
    "# Optional runtime values (compose.prod.yml supplies defaults)",
    "",
    optional.join("\n\n"),
  ].join("\n")}\n`;
};

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

const referencePage = (registries: Registry[], updated: string): string => {
  const tables = registries.map((registry) => {
    const rows = Object.entries(registry.specs).map(([key, spec]) => {
      const doc = spec.aliases?.length ? `${spec.doc} Aliases: ${spec.aliases.map((alias) => `\`${alias}\``).join(", ")}.` : spec.doc;
      return `| \`${key}\` | ${typeLabel(spec.schema)} | ${scope(spec)} | ${cell(defaultLabel(spec))} | ${spec.required ? "yes" : "no"} | ${cell(doc)} |`;
    });
    return [
      `## ${registry.name === "Platform" ? "Platform" : `Application: ${registry.name}`}`,
      "",
      `Declared in \`${registry.source}\`.`,
      "",
      "| Variable | Type | Scope | Default | Required | Description |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows,
    ].join("\n");
  });
  return `${[
    "---",
    "title: Configuration reference",
    "navTitle: Configuration reference",
    "section: Operations",
    "order: 1142",
    "description: Every environment variable Cloud processes read, generated from the configuration registries.",
    "tags: [configuration, environment, reference]",
    `updated: ${updated}`,
    "---",
    "",
    "# Configuration reference",
    "",
    "Generated by `bun scripts/generate-config-docs.ts` from the environment registries; do not edit by hand.",
    "Each variable is declared once with a schema, default and scope. Values are trimmed and",
    "empty values are treated as unset. `runtime` variables configure deployed processes,",
    "`secret` variables are credentials, and `development` variables only matter for host-run",
    "development or tooling. For the prose guide, read",
    "[Runtime configuration](/en/docs/operations/runtime-configuration).",
    ...tables.map((table) => `\n${table}`),
  ].join("\n")}\n`;
};

const outputs = async (): Promise<Record<string, string>> => {
  const registries = await loadRegistries();
  const referencePath = "docs-site/docs/en/operations/configuration.md";
  const existing = await Bun.file(`${root}${referencePath}`)
    .text()
    .catch(() => "");
  const today = new Date().toISOString().slice(0, 10);
  const previousUpdated = existing.match(/^updated: (\d{4}-\d{2}-\d{2})$/m)?.[1];
  let reference = referencePage(registries, previousUpdated ?? today);
  if (reference !== existing) reference = referencePage(registries, today);
  return {
    ".env.example": developmentEnv(
      registries,
      [...new Set([...(await composeKeys("compose.yml")), ...(await composeKeys("compose.dev.yml"))])].sort(),
    ),
    ".env.prod.example": productionEnv(registries, await composeKeys("compose.prod.yml")),
    [referencePath]: reference,
  };
};

const files = await outputs();
let stale = 0;
for (const [path, content] of Object.entries(files)) {
  const current = await Bun.file(`${root}${path}`)
    .text()
    .catch(() => "");
  if (current === content) continue;
  if (check) {
    stale += 1;
    const before = current.split("\n");
    const after = content.split("\n");
    const removed = before.filter((line) => !after.includes(line)).length;
    const added = after.filter((line) => !before.includes(line)).length;
    console.error(`${path} is stale (+${added} -${removed} lines); run \`bun scripts/generate-config-docs.ts\``);
    continue;
  }
  await Bun.write(`${root}${path}`, content);
  console.log(`wrote ${path}`);
}
if (check && stale > 0) process.exit(1);
if (check) console.log("configuration files are in sync");
