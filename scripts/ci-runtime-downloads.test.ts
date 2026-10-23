import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceRoot } from "./workspace";

// Exercise the real shell helpers with failing tools, without network, Docker
// or two-minute waits. Every tool invocation is recorded in the fixture.
const fixture = async (env: Record<string, string>, run: (root: string, env: Record<string, string | undefined>) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-ci-downloads-"));
  try {
    await mkdir(join(root, "bin"));
    const mock = `#!/usr/bin/env bash
set -eu
tool=$(basename "$0")
echo "$tool $*" >> "$FIXTURE/calls"
count() {
  local file="$FIXTURE/$1" n=0
  if [[ -f "$file" ]]; then n=$(cat "$file"); fi
  n=$((n + 1)); echo "$n" > "$file"
  [[ "$n" -gt "$2" ]]
}
case "$tool" in
  sleep) ;;
  npm) count npm-attempts "\${NPM_FAILURES:-0}" || exit 7 ;;
  timeout)
    shift
    if [[ "$1" == bash ]]; then
      count ready-attempts "\${READY_FAILURES:-0}" || exit 124
    else
      exec "$@"
    fi ;;
  docker)
    case "$1" in
      run) count start-attempts "\${START_FAILURES:-0}" || exit 125 ;;
      logs) echo "server diagnostic" ;;
    esac ;;
esac
`;
    for (const tool of ["sleep", "npm", "timeout", "docker"]) {
      const path = join(root, "bin", tool);
      await writeFile(path, mock);
      await chmod(path, 0o755);
    }
    await run(root, { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE: root, RUNNER_TEMP: root, ...env });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const execute = async (script: string, env: Record<string, string | undefined>, args: string[] = []) => {
  const child = Bun.spawn([join(workspaceRoot, ".github", script), ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
};

test("download retries recover, stop after three attempts and preserve the failure status", async () => {
  for (const failures of [2, 3]) {
    await fixture({ NPM_FAILURES: String(failures) }, async (root, env) => {
      const result = await execute("retry.sh", env, ["timeout", "120s", "npm", "install"]);
      expect(result.code).toBe(failures === 2 ? 0 : 7);
      expect(await readFile(join(root, "npm-attempts"), "utf8")).toBe("3\n");
      expect(result.output).toContain("attempt 2/3");
    });
  }
});

test("a timed-out Playwright start logs and recreates the container without reinstalling", async () => {
  await fixture({ NPM_FAILURES: "1", READY_FAILURES: "2" }, async (root, env) => {
    const result = await execute("start-playwright.sh", env);
    expect(result.code).toBe(0);
    expect(result.output.match(/server diagnostic/g)).toHaveLength(2);
    const calls = await readFile(join(root, "calls"), "utf8");
    expect(calls.match(/^docker run /gm)).toHaveLength(3);
    expect(calls.match(/^docker rm --force playwright$/gm)).toHaveLength(2);
    expect(calls.match(/^npm install /gm)).toHaveLength(2);
    const version = (await Bun.file(join(workspaceRoot, "package.json")).json()).workspaces.catalog.playwright;
    expect(calls).toContain(`--save-exact playwright@${version}`);
    expect(calls).toContain(
      `mcr.microsoft.com/playwright:v${version}-noble node /opt/playwright/node_modules/playwright/cli.js run-server`,
    );
    expect(calls).not.toContain("npx");
  });
});

test("exhausted readiness and Docker start failures fail the job and remove the last container", async () => {
  for (const env of [{ READY_FAILURES: "3" }, { START_FAILURES: "3" }]) {
    await fixture(env, async (root, variables) => {
      const result = await execute("start-playwright.sh", variables);
      expect(result.code).toBe(1);
      expect(result.output).toContain("attempt 3/3");
      const calls = await readFile(join(root, "calls"), "utf8");
      expect(calls.match(/^docker run /gm)).toHaveLength(3);
      expect(calls.match(/^docker logs playwright$/gm)).toHaveLength(3);
      expect(calls.trim().endsWith("docker rm --force playwright")).toBe(true);
    });
  }
});

test("an exhausted package download fails before starting the server", async () => {
  await fixture({ NPM_FAILURES: "3" }, async (root, env) => {
    expect((await execute("start-playwright.sh", env)).code).toBe(7);
    expect(await readFile(join(root, "calls"), "utf8")).not.toContain("docker run");
  });
});
