import assert from "node:assert/strict";
import { dirname } from "node:path";
import { sql } from "bun";

assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/cloud_oauth_verify_regressions");
assert.equal(new URL(process.env.DATABASE_URL!).hostname, "127.0.0.1");
const nativePackage = dirname(Bun.resolveSync("@firecrawl/anydoc", "/app/packages/cloud"));
const sourcePackage = dirname(Bun.resolveSync("@firecrawl/anydoc", "/workspace/packages/cloud"));
assert.equal(
  (await Bun.file(`${nativePackage}/package.json`).json()).version,
  (await Bun.file(`${sourcePackage}/package.json`).json()).version,
  "The Linux image must provide the source checkout's anydoc version",
);
const env = {
  ...process.env,
  APP_ID: "core",
  OAUTH_VERIFY_VERSION: "current",
  OAUTH_VERIFY_ISSUER: "http://localhost:3000",
  CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: "43".repeat(32),
  CLOUD_IDENTITY_JWKS_ORIGIN: "http://127.0.0.1:4301",
  CLOUD_OAUTH_JWKS_ORIGIN: "http://127.0.0.1:4302",
  CLOUD_CORE_INTERNAL_ORIGIN: "http://127.0.0.1:4301",
  CLOUD_OAUTH_BROKER_SECRET: "ab".repeat(32),
  // Host installs may contain macOS-only native packages. Resolve the matching
  // optional native dependency from the existing Linux image, without downloads.
  NAPI_RS_NATIVE_LIBRARY_PATH: Bun.resolveSync(`@firecrawl/anydoc-linux-${process.arch}-gnu`, nativePackage),
};
const children: ReturnType<typeof Bun.spawn>[] = [];
const start = async (role: "core" | "oauth") => {
  const ready = Promise.withResolvers<void>();
  const child = Bun.spawn(["bun", "src/verification/server.ts"], {
    env: {
      ...env,
      APP_ID: role,
      CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: role === "core" ? env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY : "",
    },
    stdout: "inherit",
    stderr: "inherit",
    ipc(message) {
      if (message === "ready") ready.resolve();
    },
  });
  children.push(child);
  void child.exited.then((code) => ready.reject(new Error(`Fixture ${role} exited before readiness (${code})`)));
  const timer = setTimeout(() => ready.reject(new Error(`Fixture ${role} readiness timeout`)), 60_000);
  try {
    await ready.promise;
  } finally {
    clearTimeout(timer);
  }
};
try {
  await start("core");
  await start("oauth");
  const tests = Bun.spawn(
    [
      "bun",
      "test",
      "packages/oauth/src/service/tokens.test.ts",
      "packages/cloud/src/ai/store.integration.test.ts",
      "packages/cloud/src/ai/chat-tasks.integration.test.ts",
    ],
    { cwd: "/workspace", env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([new Response(tests.stdout).text(), new Response(tests.stderr).text(), tests.exited]);
  await Bun.write("/results/full-regressions.txt", stdout + stderr);
  console.log(stdout + stderr);
  assert.equal(code, 0, "Isolated OAuth/AI regressions failed");
  assert(!/\b[1-9][0-9]* skip\b/.test(stdout + stderr), "Database regressions must not silently skip");
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null) child.send("stop");
    await child.exited;
  }
  await sql.close();
}
