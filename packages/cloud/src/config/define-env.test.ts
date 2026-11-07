import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineEnv, type EnvSpec, envBoolean, envSource } from "./index";

const keys = ["TEST_SECRET", "TEST_SECRET_ALIAS", "TEST_SECRET_FILE", "TEST_FLAG", "TEST_COUNT"];
const secret = {
  schema: z.string(),
  aliases: ["TEST_SECRET_ALIAS"],
  secretFile: true,
  scope: "secret",
  doc: "Test secret.",
} satisfies EnvSpec<string>;
let directory: string;
let original: Record<string, string | undefined>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cloud-env-"));
  original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
});

afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  rmSync(directory, { recursive: true, force: true });
});

const file = (contents: string): string => {
  const path = join(directory, "secret");
  writeFileSync(path, contents, { mode: 0o600 });
  process.env.TEST_SECRET_FILE = path;
  return path;
};

test.each([
  ["value", "value"],
  ["value\n", "value"],
  ["value\r\n", "value"],
  ["value\n\n", "value\n"],
  ["value\r\n\r\n", "value\r\n"],
  ["  value \t\n", "  value \t"],
  ["\nvalue\ninside\r", "\nvalue\ninside\r"],
  [" \n", " "],
])("file contents %j become %j without trimming other whitespace", (contents, expected) => {
  file(contents);
  const registry = defineEnv({ TEST_SECRET: { ...secret } });
  expect(registry.TEST_SECRET).toBe(expected);
  expect(envSource(registry, "TEST_SECRET")).toBe("file");
});

test.each(["", "\n", "\r\n"])("empty file %j follows unset/default/required rules", (contents) => {
  file(contents);
  const registry = defineEnv({ TEST_SECRET: { ...secret } });
  expect(registry.TEST_SECRET).toBeUndefined();
  expect(envSource(registry, "TEST_SECRET")).toBe("unset");
  const withDefault = defineEnv({ TEST_SECRET: { ...secret, default: "fallback" } });
  expect(withDefault.TEST_SECRET).toBe("fallback");
  expect(envSource(withDefault, "TEST_SECRET")).toBe("default");
  expect(() => defineEnv({ TEST_SECRET: { ...secret, required: true } })).toThrow("TEST_SECRET is required");
});

test.each(["TEST_SECRET", "TEST_SECRET_ALIAS"])("%s conflicts with a file during registry creation", (key) => {
  file("never-print-this");
  process.env[key] = "env-secret";
  expect(() => defineEnv({ TEST_SECRET: { ...secret } })).toThrow(`${key} and TEST_SECRET_FILE must not both be set`);
});

test("missing and unreadable paths fail at creation with only the variable and path", () => {
  // A directory cannot be read as a UTF-8 file, even when tests run as root.
  for (const path of [join(directory, "missing"), directory]) {
    process.env.TEST_SECRET_FILE = path;
    expect(() => defineEnv({ TEST_SECRET: { ...secret } })).toThrow(`TEST_SECRET_FILE could not read file ${JSON.stringify(path)}`);
  }
});

test("empty direct values, aliases and file paths retain the registry's unset semantics", () => {
  for (const empty of ["", " \t "]) {
    process.env.TEST_SECRET = empty;
    process.env.TEST_SECRET_ALIAS = empty;
    file("from-file");
    const registry = defineEnv({ TEST_SECRET: { ...secret } });
    expect(registry.TEST_SECRET).toBe("from-file");
    expect(envSource(registry, "TEST_SECRET")).toBe("file");
    process.env.TEST_SECRET_FILE = empty;
    expect(registry.TEST_SECRET).toBeUndefined();
    expect(envSource(registry, "TEST_SECRET")).toBe("unset");
    process.env.TEST_SECRET = "direct";
    const direct = defineEnv({ TEST_SECRET: { ...secret } });
    expect(direct.TEST_SECRET).toBe("direct");
    expect(envSource(direct, "TEST_SECRET")).toBe("env");
  }
});

test("file values stay stable if a mounted file changes or disappears; a new path is read", () => {
  const path = file("initial\n");
  const registry = defineEnv({ TEST_SECRET: { ...secret } });
  writeFileSync(path, "changed");
  expect(registry.TEST_SECRET).toBe("initial");
  rmSync(path);
  expect(registry.TEST_SECRET).toBe("initial");
  expect(envSource(registry, "TEST_SECRET")).toBe("file");
  const next = join(directory, "next-secret");
  writeFileSync(next, "next\n");
  process.env.TEST_SECRET_FILE = next;
  expect(registry.TEST_SECRET).toBe("next");
});

test("secret schema failures cannot echo file contents in the error message", () => {
  file("never-print-this");
  expect(() => defineEnv({ TEST_SECRET: { ...secret, schema: z.string().refine(() => false, "never-print-this") } })).toThrow(
    /^TEST_SECRET is invalid$/,
  );
});

test("file support is opt-in and ordinary environment values keep their lazy, trimmed precedence", () => {
  file("ignored");
  const registry = defineEnv({ TEST_SECRET: { schema: z.string(), aliases: ["TEST_SECRET_ALIAS"], doc: "Not file-enabled." } });
  expect(registry.TEST_SECRET).toBeUndefined();
  expect(envSource(registry, "TEST_SECRET")).toBe("unset");
  process.env.TEST_SECRET_ALIAS = " alias ";
  expect(registry.TEST_SECRET).toBe("alias");
  expect(envSource(registry, "TEST_SECRET")).toBe("alias");
  process.env.TEST_SECRET = " canonical ";
  expect(registry.TEST_SECRET).toBe("canonical");
  expect(envSource(registry, "TEST_SECRET")).toBe("env");
  process.env.TEST_SECRET = " \t ";
  expect(registry.TEST_SECRET).toBe("alias");
  expect(envSource(registry, "TEST_SECRET")).toBe("alias");
});

test("source detection distinguishes explicit false and zero from defaults without evaluating factories", () => {
  let evaluations = 0;
  const registry = defineEnv({
    TEST_SECRET: { schema: z.string(), default: () => String(++evaluations), doc: "Computed default." },
    TEST_FLAG: { schema: envBoolean, default: true, doc: "Flag." },
    TEST_COUNT: { schema: z.coerce.number(), default: 5, doc: "Count." },
  });
  expect(envSource(registry, "TEST_SECRET")).toBe("default");
  expect(evaluations).toBe(0);
  expect(registry.TEST_SECRET).toBe("1");
  process.env.TEST_FLAG = "false";
  process.env.TEST_COUNT = "0";
  expect(registry.TEST_FLAG).toBe(false);
  expect(registry.TEST_COUNT).toBe(0);
  expect(envSource(registry, "TEST_FLAG")).toBe("env");
  expect(envSource(registry, "TEST_COUNT")).toBe("env");
  process.env.TEST_FLAG = "";
  expect(registry.TEST_FLAG).toBe(true);
  expect(envSource(registry, "TEST_FLAG")).toBe("default");
});

test("later environment changes remain visible and get the same file conflict checks", () => {
  const registry = defineEnv({ TEST_SECRET: { ...secret } });
  file("value\n");
  expect(registry.TEST_SECRET).toBe("value");
  expect(envSource(registry, "TEST_SECRET")).toBe("file");
  process.env.TEST_SECRET_ALIAS = "conflict";
  expect(() => registry.TEST_SECRET).toThrow("TEST_SECRET_ALIAS and TEST_SECRET_FILE");
  expect(() => envSource(registry, "TEST_SECRET")).toThrow("TEST_SECRET_ALIAS and TEST_SECRET_FILE");
});

test("platform and application modules reject bad files before any getter is accessed", async () => {
  const modules = [
    { path: new URL("./env.ts", import.meta.url).pathname, key: "APP_SECRET" },
    { path: new URL("../../../../pwas/pwa-auth/server/env.ts", import.meta.url).pathname, key: "CLOUD_LOGIN_VAPID_PRIVATE_KEY" },
  ];
  for (const { path, key } of modules) {
    const missing = join(directory, "missing");
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `await import(${JSON.stringify(path)}); console.log("loaded")`], {
      env: { PATH: process.env.PATH ?? "", [`${key}_FILE`]: missing },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status).not.toBe(0);
    expect(output).not.toContain("loaded");
    expect(error).toContain(`${key}_FILE could not read file ${JSON.stringify(missing)}`);
  }
});
