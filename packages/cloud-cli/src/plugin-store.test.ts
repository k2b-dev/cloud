import { describe, expect, test } from "bun:test";
import { type LockedPlugin, readPluginLock, readServedPlugins, resolveShortNames } from "./plugin-store";

const entry = (metadata: Partial<LockedPlugin> = {}): LockedPlugin => ({
  app: "test-app",
  version: "1.0.0",
  digest: "a".repeat(128),
  summary: "Test",
  ...metadata,
});

const taken = (modules: string[] = [], builtIn: string[] = [], served: ReadonlySet<string> | undefined = new Set<string>()) => ({
  modules: new Set(modules),
  builtIn: new Set(builtIn),
  served,
});

describe("short-name resolution", () => {
  test("resolves aliases and multi-segment shortcuts", () => {
    const result = resolveShortNames({ assistant: entry({ alias: "ai", shortcuts: { inbox: "messages list" } }) }, taken(["assistant"]));
    expect([...result.active.values()]).toEqual([
      { name: "ai", module: "assistant", path: [] },
      { name: "inbox", module: "assistant", path: ["messages", "list"] },
    ]);
    expect(result.inactive).toEqual([]);
  });

  test("disables every claimant, sorted by name and module, regardless of install order", () => {
    const result = resolveShortNames(
      {
        foo: entry({ alias: "ai", shortcuts: { inbox: "messages list" } }),
        assistant: entry({ alias: "ai", shortcuts: { inbox: "messages list" } }),
      },
      taken(),
    );
    expect(result.active.size).toBe(0);
    expect(result.inactive).toEqual([
      { name: "ai", claimedBy: ["assistant", "foo"], reason: "ambiguous" },
      { name: "inbox", claimedBy: ["assistant", "foo"], reason: "ambiguous" },
    ]);
  });

  test("built-in names win even over ambiguous or module claims", () => {
    const result = resolveShortNames({ assistant: entry({ alias: "help" }), foo: entry({ alias: "help" }) }, taken(["help"], ["help"]));
    expect(result.active.size).toBe(0);
    expect(result.inactive).toEqual([{ name: "help", claimedBy: ["assistant", "foo"], reason: "built-in" }]);
  });

  for (const source of ["installed", "package"]) {
    test(`protects ${source} module names`, () => {
      const lock = { foo: entry({ alias: "mail" }), ...(source === "installed" ? { mail: entry() } : {}) };
      const result = resolveShortNames(lock, taken(["foo", "mail"]));
      expect(result.active.size).toBe(0);
      expect(result.inactive).toEqual([{ name: "mail", claimedBy: ["foo"], reason: "module" }]);
    });
  }

  test("protects served-only module names", () => {
    const result = resolveShortNames({ echo: entry({ alias: "mail" }) }, taken(["echo"], [], new Set(["mail"])));
    expect(result.active.size).toBe(0);
    expect(result.inactive).toEqual([{ name: "mail", claimedBy: ["echo"], reason: "module" }]);
  });

  test("missing served names disable aliases and shortcuts after checking conflicts", () => {
    const result = resolveShortNames(
      {
        echo: entry({ alias: "e", shortcuts: { me: "whoami", help: "whoami", mail: "whoami", shared: "whoami" } }),
        foo: entry({ shortcuts: { help: "whoami", mail: "whoami", shared: "whoami" } }),
      },
      { ...taken(["help", "mail"], ["help"]), served: undefined },
    );
    expect(result.active.size).toBe(0);
    expect(result.inactive).toEqual([
      { name: "e", claimedBy: ["echo"], reason: "unverified" },
      { name: "help", claimedBy: ["echo", "foo"], reason: "built-in" },
      { name: "mail", claimedBy: ["echo", "foo"], reason: "module" },
      { name: "me", claimedBy: ["echo"], reason: "unverified" },
      { name: "shared", claimedBy: ["echo", "foo"], reason: "ambiguous" },
    ]);
  });

  test("ignores all short names of a shadowed plugin", () => {
    const result = resolveShortNames({ help: entry({ alias: "ai", shortcuts: { inbox: "messages list" } }) }, taken([], ["help"]));
    expect(result.active.size).toBe(0);
    expect(result.inactive).toEqual([]);
  });
});

describe("served plugin snapshot", () => {
  test("accepts only complete lists of valid module names", () => {
    const names = ["echo", "mail"];
    expect(readServedPlugins(names)).toBe(names);
    expect(readServedPlugins([])).toEqual([]);
    for (const value of [5, "mail", ["Mail"], [1], ["echo", 1], null, undefined]) {
      expect(readServedPlugins(value)).toBeUndefined();
    }
  });
});

describe("plugin lock metadata", () => {
  test("keeps valid short names and omits absent fields", () => {
    expect(readPluginLock({ assistant: entry({ alias: "ai", shortcuts: { inbox: "messages list" } }) })).toEqual({
      assistant: entry({ alias: "ai", shortcuts: { inbox: "messages list" } }),
    });
    expect(readPluginLock({ assistant: entry() })).toEqual({ assistant: entry() });
  });

  test("drops only the invalid field", () => {
    for (const alias of [null, 1, "", "AI", "assistant", "a_i"]) {
      expect(readPluginLock({ assistant: { ...entry(), alias, shortcuts: { inbox: "messages list" } } })).toEqual({
        assistant: entry({ shortcuts: { inbox: "messages list" } }),
      });
    }
    for (const shortcuts of [
      null,
      [],
      "bad",
      new Map(),
      { assistant: "messages list" },
      { ai: "messages list" },
      { Inbox: "messages list" },
      { inbox: "" },
      { inbox: "  " },
      { inbox: "messages --json" },
      { inbox: 1 },
    ]) {
      expect(readPluginLock({ assistant: { ...entry({ alias: "ai" }), shortcuts } })).toEqual({ assistant: entry({ alias: "ai" }) });
    }
  });
});

describe("shared bundle verification", () => {
  test("served and local readers share verification, module checks, reuse and failure cleanup", async () => {
    const { mkdtemp, readdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { cloudCliPluginDigest, sha512Hex } = await import("@k2b/cloud/cli");
    const { downloadPlugin, placePlugin, storePlugin } = await import("./plugin-store");
    const root = await mkdtemp(join(tmpdir(), "shared-plugin-store-"));
    const encoder = new TextEncoder();
    const source = 'export default { name: "verified", summary: "Verified", run: () => 0 };';
    const bytes = new Map([
      ["cli.js", encoder.encode(source)],
      ["references/index.md", encoder.encode("# Verified\n")],
    ]);
    const files = [...bytes].map(([path, content]) => ({ path, size: content.byteLength, sha512: sha512Hex(content) }));
    const manifest = {
      apiVersion: 1,
      name: "verified",
      app: "verified-package",
      version: "1.0.0",
      entry: "cli.js" as const,
      files,
      digest: cloudCliPluginDigest(files),
    };
    const store = join(root, "store");
    try {
      const download = await downloadPlugin(async (path) => new Response(bytes.get(path.split("/verified/")[1]!)), manifest, root);
      expect(download.module.name).toBe("verified");
      await placePlugin(download.incoming, manifest.digest, root);
      const local = await storePlugin(manifest, async (file) => bytes.get(file.path)!, root);
      expect(local.module.summary).toBe("Verified");
      await placePlugin(local.incoming, manifest.digest, root);
      expect(await readdir(store)).toEqual([manifest.digest]);
      for (const size of [-1, 1]) {
        await expect(
          downloadPlugin(
            async (path) => new Response(new Uint8Array(bytes.get(path.split("/verified/")[1]!)!.byteLength + size)),
            manifest,
            root,
          ),
        ).rejects.toThrow(size < 0 ? "smaller" : "larger");
        expect(await readdir(store)).toEqual([manifest.digest]);
      }
      await expect(storePlugin(manifest, async (file) => new Uint8Array(file.size), root)).rejects.toThrow("SHA-512");
      expect(await readdir(store)).toEqual([manifest.digest]);
      const changed = new Map(bytes);
      changed.set("cli.js", encoder.encode(source.replace('"verified"', '"other"')));
      const changedFiles = [...changed].map(([path, content]) => ({ path, size: content.byteLength, sha512: sha512Hex(content) }));
      await expect(
        storePlugin(
          { ...manifest, files: changedFiles, digest: cloudCliPluginDigest(changedFiles) },
          async (file) => changed.get(file.path)!,
          root,
        ),
      ).rejects.toThrow('exports the module "other"');
      expect(await readdir(store)).toEqual([manifest.digest]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
