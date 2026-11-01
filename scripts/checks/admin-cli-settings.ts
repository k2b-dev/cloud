import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

// Structured settings use their owning service, rather than bypassing hooks with a raw setting write.
const structured: Readonly<Record<string, { file: string; command: string }>> = Object.fromEntries([
  ...[
    "core.code.source_bytes",
    "core.code.source_files",
    "core.code.bundle_bytes",
    "core.code.manifest_bytes",
    "core.code.payload_bytes",
    "core.code.calls_per_run",
    "core.code.wall_clock_ms",
    "core.code.database_bytes",
    "core.code.ai_budget_usd",
    "core.code.concurrency_per_code",
    "core.code.concurrency_per_owner",
  ].map((key) => [key, { file: "packages/cloud/src/cli/admin/administration.ts", command: "settings apply" }]),
  ...["assistant.storage_file_mib", "assistant.storage_total_mib"].map((key) => [
    key,
    { file: "packages/assistant/src/cli/code.ts", command: "studio-admin storage-configure" },
  ]),
  ...["assistant.rsql_url", "assistant.rsql_api_token", "assistant.rsql_allowed_targets"].map((key) => [
    key,
    { file: "packages/assistant/src/cli/code.ts", command: "studio-admin configure" },
  ]),
  ...[
    "max_bases",
    "max_raw_retention_days",
    "default_values_per_minute",
    "default_bytes_per_minute",
    "default_storage_bytes",
    "default_max_series",
    "default_max_event_kinds",
    "default_queries_per_hour",
    "default_max_state_keys",
    "base_creation",
    "default_profile",
  ].map((key) => [`pulse.${key}`, { file: "packages/pulse/src/cli/admin.ts", command: "admin policy set" }]),
  ["pulse.clickhouse_connection", { file: "packages/pulse/src/cli/admin.ts", command: "admin store set" }],
  ["filesv2.configuration", { file: "packages/filesv2/src/cli-admin.ts", command: "admin configuration set" }],
  ...["weather.default_lat", "weather.default_lon", "weather.cache_minutes"].map((key) => [
    key,
    { file: "packages/cloud/src/cli/admin/administration.ts", command: "weather config set" },
  ]),
  ["geo.api_key", { file: "packages/cloud/src/cli/admin/administration.ts", command: "geo key set" }],
]);

export const rule: Rule = {
  name: "admin-cli-settings",
  description: "Every declared administrator setting has a cld command through its owning setter",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const cli = readFileSync(join(workspaceRoot, "packages/cloud/src/cli/admin/settings.ts"), "utf8");
    const ownerPaths = new Set([...cli.matchAll(/^\s*(?:"([\w-]+)"|(\w+)):\s*"\/api\//gm)].map((match) => match[1] ?? match[2]));
    for (const file of listFiles(join(workspaceRoot, "packages"), /\.ts$/).filter(
      (file) => !isTestFile(file) && !file.includes("test-fixture"),
    )) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("kind:") || !source.includes("default:")) continue;
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const owner = relative(join(workspaceRoot, "packages"), file).split("/")[0]!;
      const visit = (node: ts.Node): void => {
        if (
          ts.isPropertyAssignment(node) &&
          ts.isStringLiteralLike(node.name) &&
          node.name.text.includes(".") &&
          ts.isObjectLiteralExpression(node.initializer)
        ) {
          const props = node.initializer.properties.filter(ts.isPropertyAssignment);
          const property = (name: string) => props.find((prop) => prop.name.getText(tree) === name);
          if (property("kind") && property("default")) {
            const key = node.name.text;
            const mapped = structured[key];
            const commandSource = mapped ? readFileSync(join(workspaceRoot, mapped.file), "utf8") : cli;
            const command = mapped?.command ?? "settings set";
            const supported =
              mapped ||
              (!property("adminWrite") && file.endsWith("/services/settings/core-settings.ts")) ||
              (!property("adminWrite") && ownerPaths.has(owner) && key.startsWith(`${owner === "gateway-ops" ? "gateway" : owner}.`)) ||
              (!property("adminWrite") && (property("envBootstrap") || property("envFallback")));
            if (!supported || !(commandSource.includes(`command("${command}"`) || commandSource.includes(`command: "${command}"`)))
              findings.push({
                file,
                line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
                message: `${key}: every admin setting needs a cld command; wire the owning API and add its structured mapping when a custom setter is required`,
              });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    return findings;
  },
};
