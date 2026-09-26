import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { cliPluginListRoutes } from "../api/cli-plugins";
import { CLOUD_CLI_API_VERSION, parseCloudCliPluginManifest, sha512Hex } from "../cli/plugin";
import { env } from "../config/env";
import type { AppRegistryEntry } from "../contracts/registry";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import * as settings from "../services/settings";
import { buildCliPlugin, createCliPluginRoutes, validateAppCliModules, writeCliPlugin } from "./cli-plugins";
import * as registry from "./registry";
import { validateAppRegistryEntry } from "./registry-validation";

const cliIndex = resolve(import.meta.dir, "../cli/index.ts");
const declaration = { module: "src/cli.ts", references: "src/cli-references" };
let appDir: string;

const writeApp = async (directory: string, moduleName: string) => {
  await mkdir(join(directory, "src/cli-references/guides"), { recursive: true });
  await writeFile(
    join(directory, "src/cli.ts"),
    `import { command, defineCliCommands } from ${JSON.stringify(cliIndex)};
export default defineCliCommands({
  name: ${JSON.stringify(moduleName)},
  summary: "Manage inventory.",
  commands: [command("ping", { summary: "Ping", run: ({ ctx }) => ctx.print("pong") })],
});
`,
  );
  await writeFile(join(directory, "src/cli-references/index.md"), "# Inventory\n\nSee guides/items.md.\n");
  await writeFile(join(directory, "src/cli-references/guides/items.md"), "# Items\n");
};

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "cloud-cli-plugin-app-"));
  await writeApp(appDir, "inventory");
});

afterAll(async () => {
  await rm(appDir, { recursive: true, force: true });
});

describe("CLI plugin declarations", () => {
  test("accept kebab-case names with relative paths", () => {
    expect(validateAppCliModules("inventory", { inventory: declaration, "inventory-admin": declaration })).toEqual([
      "inventory",
      "inventory-admin",
    ]);
    expect(validateAppCliModules("inventory", undefined)).toEqual([]);
  });

  test("reject invalid names and absolute or empty paths", () => {
    expect(() => validateAppCliModules("inventory", { Inventory: declaration })).toThrow("kebab-case");
    expect(() => validateAppCliModules("inventory", { inventory: { ...declaration, module: "/abs/cli.ts" } })).toThrow("relative module");
    expect(() => validateAppCliModules("inventory", { inventory: { ...declaration, references: "" } })).toThrow("relative references");
  });

  test("registry entries list only valid module names", () => {
    const entry = { id: "inventory", name: "Inventory", icon: "ti ti-box", description: "Stock", baseUrl: "http://app:3000", routes: [] };
    expect(validateAppRegistryEntry({ ...entry, cliModules: ["inventory"] })).toBeNull();
    expect(validateAppRegistryEntry({ ...entry, cliModules: ["../x"] })).toBe("cliModules must be an array of CLI module names");
  });
});

describe("buildCliPlugin", () => {
  test("bundles the module with its references into a verifiable manifest", async () => {
    const plugin = await buildCliPlugin({ appDir, appId: "inventory-app", name: "inventory", declaration, version: "1.4.0" });
    expect(plugin.manifest).toMatchObject({ apiVersion: CLOUD_CLI_API_VERSION, name: "inventory", app: "inventory-app", version: "1.4.0" });
    expect(plugin.manifest.files.map((file) => file.path)).toEqual(["cli.js", "references/guides/items.md", "references/index.md"]);
    for (const file of plugin.manifest.files) expect(file.sha512).toBe(sha512Hex(plugin.files.get(file.path)!));
    expect(parseCloudCliPluginManifest(JSON.parse(JSON.stringify(plugin.manifest)))).toEqual(plugin.manifest);
    // The bundle is self-contained: it no longer imports the platform package.
    expect(new TextDecoder().decode(plugin.files.get("cli.js"))).not.toContain(cliIndex);

    const out = await mkdtemp(join(tmpdir(), "cloud-cli-plugin-out-"));
    try {
      await writeCliPlugin(out, plugin);
      expect(JSON.parse(await readFile(join(out, "manifest.json"), "utf8"))).toEqual(plugin.manifest);
      expect(await readFile(join(out, "references/guides/items.md"), "utf8")).toBe("# Items\n");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("refuses a module whose exported name differs from its declaration", async () => {
    const plugin = await buildCliPlugin({ appDir, appId: "inventory-app", name: "stock", declaration, version: "1.4.0" });
    const out = await mkdtemp(join(tmpdir(), "cloud-cli-plugin-out-"));
    try {
      await expect(writeCliPlugin(out, plugin)).rejects.toThrow('CLI module declared as "stock" exports the name "inventory"');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("requires index.md and only Markdown references", async () => {
    const other = await mkdtemp(join(tmpdir(), "cloud-cli-plugin-app-"));
    try {
      await writeApp(other, "inventory");
      await writeFile(join(other, "src/cli-references/notes.txt"), "no");
      await expect(buildCliPlugin({ appDir: other, appId: "a", name: "inventory", declaration, version: "1.0.0" })).rejects.toThrow(
        "must be a Markdown file",
      );
      await rm(join(other, "src/cli-references/notes.txt"));
      await rm(join(other, "src/cli-references/index.md"));
      await expect(buildCliPlugin({ appDir: other, appId: "a", name: "inventory", declaration, version: "1.0.0" })).rejects.toThrow(
        "need an index.md",
      );
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("manifests with a tampered file hash fail verification", async () => {
    const plugin = await buildCliPlugin({ appDir, appId: "inventory-app", name: "inventory", declaration, version: "1.4.0" });
    const tampered = {
      ...plugin.manifest,
      files: plugin.manifest.files.map((file, index) => (index === 0 ? { ...file, sha512: "0".repeat(128) } : file)),
    };
    expect(() => parseCloudCliPluginManifest(tampered)).toThrow("digest does not match");
  });
});

describe("served plugin routes", () => {
  const signIn = (profile: "user" | "guest") => {
    const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile, effective_admin: false });
    return spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "test", authEpoch: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
  };
  const withAccess = (access: string) => spyOn(settings, "get").mockResolvedValue(access as never);
  const headers = { Cookie: "session_token=test", Accept: "application/json" };

  const server = () => new Hono().route("/cli/plugins", createCliPluginRoutes("inventory-app", { inventory: declaration }));

  test("serve the manifest and listed files to full accounts in development", async () => {
    const appDirDescriptor = Object.getOwnPropertyDescriptor(env, "APP_DIR")!;
    Object.defineProperty(env, "APP_DIR", { value: appDir, configurable: true });
    const authenticate = signIn("user");
    const access = withAccess("full_users");
    try {
      const app = server();
      const manifestResponse = await app.request("/cli/plugins/inventory/manifest.json", { headers });
      expect(manifestResponse.status).toBe(200);
      expect(manifestResponse.headers.get("cache-control")).toBe("private, no-store");
      const manifest = parseCloudCliPluginManifest(await manifestResponse.json());
      expect(manifest.name).toBe("inventory");

      for (const file of manifest.files) {
        const response = await app.request(`/cli/plugins/inventory/${file.path}`, { headers });
        expect(response.status).toBe(200);
        expect(sha512Hex(new Uint8Array(await response.arrayBuffer()))).toBe(file.sha512);
      }
      expect((await app.request("/cli/plugins/inventory/references/index.md", { headers })).headers.get("content-type")).toBe(
        "text/markdown; charset=utf-8",
      );
      expect((await app.request("/cli/plugins/inventory/package.json", { headers })).status).toBe(404);
      expect((await app.request("/cli/plugins/inventory/references%2Findex.md", { headers })).status).toBe(404);
      expect((await app.request("/cli/plugins/other/manifest.json", { headers })).status).toBe(404);
    } finally {
      authenticate.mockRestore();
      access.mockRestore();
      Object.defineProperty(env, "APP_DIR", appDirDescriptor);
    }
  });

  test("serve prebuilt files from the production build output", async () => {
    const root = await mkdtemp(join(tmpdir(), "cloud-cli-plugin-dist-"));
    const authenticate = signIn("user");
    const access = withAccess("full_users");
    try {
      const plugin = await buildCliPlugin({ appDir, appId: "inventory-app", name: "inventory", declaration, version: "2.0.0" });
      await writeCliPlugin(join(root, "inventory"), plugin);
      const app = new Hono().route("/cli/plugins", createCliPluginRoutes("inventory-app", { inventory: declaration }, root));
      expect(await (await app.request("/cli/plugins/inventory/manifest.json", { headers })).json()).toEqual(plugin.manifest);
      const bundle = await app.request("/cli/plugins/inventory/cli.js", { headers });
      expect(bundle.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(sha512Hex(new Uint8Array(await bundle.arrayBuffer()))).toBe(plugin.manifest.files[0]!.sha512);
    } finally {
      authenticate.mockRestore();
      access.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("give anonymous callers nothing and guests nothing unless all accounts may", async () => {
    const app = server();
    const anonymous = await app.request("/cli/plugins/inventory/manifest.json", { headers: { Accept: "application/json" } });
    expect(anonymous.status).toBe(401);
    expect((await app.request("/cli/plugins/inventory/cli.js")).status).toBe(401);

    const authenticate = signIn("guest");
    const access = withAccess("full_users");
    try {
      const guest = await app.request("/cli/plugins/inventory/cli.js", { headers });
      expect(guest.status).toBe(403);
      expect(await guest.json()).toEqual({ code: "FORBIDDEN", message: "CLI plugins are available to full accounts only" });
      expect(access).toHaveBeenCalledWith("cli.plugins.access");

      access.mockResolvedValue("all_users" as never);
      const appDirDescriptor = Object.getOwnPropertyDescriptor(env, "APP_DIR")!;
      Object.defineProperty(env, "APP_DIR", { value: appDir, configurable: true });
      try {
        expect((await app.request("/cli/plugins/inventory/manifest.json", { headers })).status).toBe(200);
      } finally {
        Object.defineProperty(env, "APP_DIR", appDirDescriptor);
      }
    } finally {
      authenticate.mockRestore();
      access.mockRestore();
    }
  });

  test("the list follows the same rule and names every live module", async () => {
    const entry = (id: string, cliModules?: string[]): AppRegistryEntry => ({
      id,
      name: id,
      icon: "ti ti-box",
      description: id,
      baseUrl: `http://app-${id}:3000`,
      routes: [],
      runtime: { version: "0.18.0", release: "cloud-v0.18.0", syncVersion: "6.5.0" },
      cliModules,
    });
    const apps = spyOn(registry, "listApps").mockResolvedValue([
      entry("mail", ["mail"]),
      entry("core", ["apps", "account"]),
      entry("weather"),
    ]);
    const list = new Hono().route("/cli/plugins", cliPluginListRoutes);
    try {
      expect((await list.request("/cli/plugins", { headers: { Accept: "application/json" } })).status).toBe(401);

      const access = withAccess("full_users");
      try {
        const guest = signIn("guest");
        expect((await list.request("/cli/plugins", { headers })).status).toBe(403);
        guest.mockRestore();
        const member = signIn("user");
        const response = await list.request("/cli/plugins", { headers });
        member.mockRestore();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          plugins: [
            { name: "account", app: "core", version: "0.18.0" },
            { name: "apps", app: "core", version: "0.18.0" },
            { name: "mail", app: "mail", version: "0.18.0" },
          ],
        });
      } finally {
        access.mockRestore();
      }
    } finally {
      apps.mockRestore();
    }
  });
});
