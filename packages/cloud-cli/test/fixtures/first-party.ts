import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

/**
 * Install first-party modules as package plugins under `configHome`
 * (`XDG_CONFIG_HOME`), so a test `cld` runs them without a Cloud.
 */
export const installFirstPartyModules = async (configHome: string, names: readonly string[]): Promise<void> => {
  await Promise.all(
    names.map(async (name) => {
      const directory = join(configHome, "cloud", "cld", "plugins", name);
      await mkdir(join(directory, "dist"), { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: `@k2b-test/${name}`, version: "0.0.0-test", type: "module", cld: { apiVersion: 1, entry: "dist/cli.js" } }),
      );
      await writeFile(join(directory, "dist", "cli.js"), await bundleFirstPartyModule(name));
    }),
  );
};
