import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CLOUD_CLI_API_VERSION, cloudCliPluginDigest, sha512Hex, validateCloudCliModule } from "@k2b/cloud/cli";
import { readPackagePlugins, writePackagePlugins } from "../../src/plugins";

const root = resolve(import.meta.dir, "../../../..");

/**
 * Every first-party `cld` module and its source. Core serves the shared
 * `@k2b/cloud/cli` modules; each application serves its own `src/cli.ts`.
 */
export const FIRST_PARTY_MODULES: Readonly<Record<string, string>> = {
  account: "packages/cloud/src/cli/account.ts",
  admin: "packages/cloud/src/cli/admin/index.ts",
  apps: "packages/cloud/src/cli/apps.ts",
  capabilities: "packages/cloud/src/cli/capabilities.ts",
  ...Object.fromEntries(
    [
      "accounts",
      "api-docs",
      "assistant",
      "contacts",
      "faq",
      "filesv2",
      "grids",
      "ipa-hosts",
      "mail",
      "notebooks",
      "oauth",
      "pulse",
      "spaces",
      "tools",
      "venue",
    ].map((app) => [app, `packages/${app}/src/cli.ts`]),
  ),
};

export const firstPartyModuleSource = (name: string): string => {
  const path = FIRST_PARTY_MODULES[name];
  if (!path) throw new Error(`Unknown first-party module "${name}"`);
  return resolve(root, path);
};

const bundles = new Map<string, Promise<Uint8Array>>();

/** Bundle one first-party module the way an application image does, once per process. */
export const bundleFirstPartyModule = (name: string): Promise<Uint8Array> => {
  let bundle = bundles.get(name);
  if (!bundle) {
    bundle = (async () => {
      const result = await Bun.build({
        entrypoints: [firstPartyModuleSource(name)],
        target: "bun",
        format: "esm",
        external: ["chromium-bidi/*"],
      });
      if (!result.success) throw new AggregateError(result.logs, `Failed to bundle the ${name} module.`);
      return new Uint8Array(await result.outputs[0]!.arrayBuffer());
    })();
    bundles.set(name, bundle);
  }
  return bundle;
};

/** Import each bundle once per test process; every temporary copy would otherwise load its own module graph. */
const summaries = new Map<string, Promise<string>>();
const moduleSummary = (digest: string, entry: string): Promise<string> => {
  let summary = summaries.get(digest);
  if (!summary) {
    summary = import(pathToFileURL(entry).href).then((loaded: { default?: unknown }) => validateCloudCliModule(loaded.default).summary);
    summaries.set(digest, summary);
  }
  return summary;
};

/**
 * Install first-party modules as package plugins under `configHome`
 * (`XDG_CONFIG_HOME`), so a test `cld` runs them without a Cloud. Each one is
 * written into the plugin store with a stub reference and recorded in
 * `packages.json`, the state `cld plugins install` leaves behind.
 */
export const installFirstPartyModules = async (configHome: string, names: readonly string[]): Promise<void> => {
  const root = join(configHome, "cloud", "cld", "plugins");
  const records = await readPackagePlugins(root);
  await Promise.all(
    names.map(async (name) => {
      const bytes = await bundleFirstPartyModule(name);
      const index = `# ${name}\n`;
      const files = [
        { path: "cli.js", size: bytes.byteLength, sha512: sha512Hex(bytes) },
        { path: "references/index.md", size: Buffer.byteLength(index), sha512: sha512Hex(index) },
      ];
      const digest = cloudCliPluginDigest(files);
      const directory = join(root, "store", digest);
      await mkdir(join(directory, "references"), { recursive: true });
      await writeFile(join(directory, "cli.js"), bytes);
      await writeFile(join(directory, "references", "index.md"), index);
      await writeFile(
        join(directory, "manifest.json"),
        JSON.stringify({
          apiVersion: CLOUD_CLI_API_VERSION,
          name,
          app: `@k2b-test/${name}`,
          version: "0.0.0-test",
          entry: "cli.js",
          digest,
          files,
        }),
      );
      records[name] = {
        package: `@k2b-test/${name}`,
        version: "0.0.0-test",
        digest,
        summary: await moduleSummary(digest, join(directory, "cli.js")),
        source: firstPartyModuleSource(name),
      };
    }),
  );
  await writePackagePlugins(records, root);
};
