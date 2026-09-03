import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";

// Fixed last pre-JWT revision. No checkout, stash, development DB or ports touched.
const baseline = "3ae6c09a774fc22dc36b5d01b960bd13b2a1a85d";
const root = resolve(import.meta.dir, "..");
const output = await mkdtemp(join(tmpdir(), "cloud-oauth-verification-"));
const source = join(output, "baseline");
await mkdir(source);
const command = async (args: string[], cwd = root) => {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, `${args[0]} ${args[1]} failed: ${stderr.trim()}`);
  return stdout.trim();
};
const archive = Bun.spawn(
  ["git", "archive", baseline, "packages/cloud", "packages/core", "packages/oauth", "packages/ui", "package.json", "bun.lock"],
  {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  },
);
const extract = Bun.spawn(["tar", "-xf", "-", "-C", source], { stdin: archive.stdout, stdout: "inherit", stderr: "inherit" });
assert.equal(await extract.exited, 0);
assert.equal(await archive.exited, 0);
await mkdir(join(source, "packages/oauth/src/verification"), { recursive: true });
await mkdir(join(source, "node_modules"));
for (const pkg of ["cloud", "core", "oauth", "ui"]) await mkdir(join(source, "packages", pkg, "node_modules"));
await cp(join(root, "packages/oauth/src/verification/server.ts"), join(source, "packages/oauth/src/verification/server.ts"));
const unchanged = [
  "packages/oauth/src/contracts.ts",
  "packages/oauth/src/api",
  "packages/oauth/src/frontend",
  "packages/oauth/src/service/clients.ts",
];
const publicDiff = await command(["git", "diff", baseline, "--", ...unchanged]);
assert.equal(publicDiff, "", "Previously unchanged OAuth public schemas/routes changed; review the contract baseline");
const declarations = {
  "packages/oauth/src/oauth.ts": [
    "ResourceIndicatorSchema",
    "AuthorizeQuerySchema",
    "TokenBodySchema",
    "TokenResponseSchema",
    "TokenErrorResponseSchema",
    "RevokeTokenBodySchema",
    "parseBasicAuth",
    "resolveClientCredentials",
  ],
  "packages/oauth/src/service/tokens.ts": ["getOpenIdConfiguration"],
};
for (const [file, names] of Object.entries(declarations)) {
  const initializer = (text: string, name: string) => {
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(ast) === name && declaration.initializer) return declaration.initializer.getText(ast);
      }
    }
    throw new Error(`Missing contract declaration ${file}:${name}`);
  };
  const oldSource = await Bun.file(join(source, file)).text();
  const newSource = await Bun.file(join(root, file)).text();
  for (const name of names)
    assert.equal(initializer(newSource, name), initializer(oldSource, name), `Public contract changed: ${file}:${name}`);
}
const images = { postgres: "postgres:15-alpine", redis: "valkey/valkey:8-alpine", bun: "cloud-app-core:latest" };
const imageIds: Record<string, string> = {};
for (const [key, name] of Object.entries(images))
  imageIds[key] = await command(["docker", "image", "inspect", name, "--format", "{{.Id}}"]);
await Bun.write(
  join(output, "environment.json"),
  JSON.stringify(
    {
      baseline,
      head: await command(["git", "rev-parse", "HEAD"]),
      dirty: await command(["git", "status", "--short"]),
      images,
      imageIds,
      unchanged,
      declarations,
      dependencies: "Both revisions use the installed working-tree dependency graph; this is not a historical dependency-build test.",
    },
    null,
    2,
  ),
);
// Keep reviewable source evidence, without credentials or runtime payloads.
await Bun.write(
  join(output, "oauth.diff"),
  await command(["git", "diff", baseline, "--", "packages/oauth/src/oauth.ts", "packages/oauth/src/service/tokens.ts"]),
);
const prefix = `cloud-oauth-verify-${crypto.randomUUID()}`;
const pg = `${prefix}-pg`;
const redis = `${prefix}-redis`;
const owned: string[] = [];
try {
  owned.push(pg);
  await command([
    "docker",
    "run",
    "-d",
    "--pull=never",
    "--name",
    pg,
    "--network",
    "none",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "-e",
    "POSTGRES_PASSWORD=verification-only",
    "-e",
    "POSTGRES_DB=cloud_oauth_verify_upgrade",
    images.postgres,
  ]);
  owned.push(redis);
  await command([
    "docker",
    "run",
    "-d",
    "--pull=never",
    "--name",
    redis,
    "--network",
    `container:${pg}`,
    images.redis,
    "valkey-server",
    "--bind",
    "127.0.0.1",
    "--save",
    "",
    "--appendonly",
    "no",
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await command(["docker", "exec", pg, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "postgres"]);
      assert.equal(await command(["docker", "exec", redis, "valkey-cli", "PING"]), "PONG");
      ready = true;
      break;
    } catch {
      await Bun.sleep(250);
    }
  }
  assert(ready, "Disposable services did not become ready");
  await command([
    "docker",
    "exec",
    pg,
    "psql",
    "-U",
    "postgres",
    "-d",
    "cloud_oauth_verify_upgrade",
    "-c",
    "CREATE DATABASE cloud_oauth_verify_fresh",
  ]);
  for (const scenario of ["upgrade", "fresh"]) {
    const name = `${prefix}-${scenario}`;
    owned.push(name);
    const mounts = ["cloud", "core", "oauth"].flatMap((pkg) => [
      "-v",
      `${root}/packages/${pkg}/node_modules:/baseline/packages/${pkg}/node_modules:ro`,
    ]);
    const child = Bun.spawn(
      [
        "docker",
        "run",
        "--pull=never",
        "--name",
        name,
        "--network",
        `container:${pg}`,
        "-v",
        `${root}:/workspace:ro`,
        "-v",
        `${source}:/baseline:ro`,
        "-v",
        `${root}/node_modules:/baseline/node_modules:ro`,
        ...mounts,
        "-v",
        `${root}/packages/ui:/baseline/packages/ui:ro`,
        "-v",
        `${output}:/results:rw`,
        "-w",
        "/workspace/packages/oauth",
        "-e",
        `DATABASE_URL=postgres://postgres:verification-only@127.0.0.1:5432/cloud_oauth_verify_${scenario}?sslmode=disable`,
        "-e",
        `REDIS_URL=redis://127.0.0.1:6379/${scenario === "upgrade" ? "0" : "1"}`,
        "-e",
        "NODE_ENV=development",
        "-e",
        `APP_SECRET=${"51".repeat(32)}`,
        "-e",
        "ADMIN_LOGIN_TOKEN=isolated-reference-login",
        "-e",
        "CLOUD_IDENTITY_PREVIOUS_KEY=",
        "-e",
        "CLOUD_IDENTITY_NEXT_KEY=",
        "-e",
        `OAUTH_VERIFY_FRESH=${scenario === "fresh" ? "1" : "0"}`,
        "--entrypoint",
        "bun",
        images.bun,
        "src/verification/upgrade.ts",
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    assert.equal(await child.exited, 0, `${scenario} verification failed`);
  }
  console.log(`OAuth verification passed. Evidence: ${output}`);
} finally {
  for (const name of owned.reverse()) {
    try {
      await command(["docker", "rm", "--force", name]);
    } catch {
      console.error(`Could not remove owned fixture container ${name}`);
      process.exitCode = 1;
    }
  }
  console.log(`OAuth verification artifacts: ${output}`);
}
