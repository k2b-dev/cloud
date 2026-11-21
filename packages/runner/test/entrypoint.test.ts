import { test as bunTest, expect } from "bun:test";
import { chmod, chown, lstat, mkdtemp, readFile, rmdir, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

// CI executes this bundle as root under the image's startup capability envelope.
const test = bunTest.skipIf(process.getuid?.() !== 0);
const entrypoint = join(import.meta.dir, "runner-entrypoint");

test("entrypoint stages mounted key bytes privately and permanently drops startup capabilities", async () => {
  const directory = await mkdtemp("/tmp/runner-entrypoint-test-");
  const source = join(directory, "source");
  let copy: string | undefined;
  try {
    await chmod(directory, 0o700);
    await Bun.write(source, "public-entrypoint-test-key");
    // Compose/Swarm may present a readable mount; directory traversal protects it.
    await chmod(source, 0o444);
    const child = Bun.spawn(
      [
        entrypoint,
        process.execPath,
        "--no-env-file",
        "-e",
        `
        const path = process.env.CLOUD_APP_KEY_FILE;
        const status = await Bun.file('/proc/self/status').text();
        const reader = Bun.spawn([${JSON.stringify(join(import.meta.dir, "runner-isolate"))}, '30000', ${JSON.stringify(join(directory, "probe.sock"))}, '/bin/cat', ${JSON.stringify(source)}, path], {stdout:'pipe',stderr:'pipe'});
        const output = await new Response(reader.stdout).text();
        const errors = await new Response(reader.stderr).text();
        console.log(JSON.stringify({path, status, readExit: await reader.exited, output, errors}));
      `,
      ],
      { env: { CLOUD_APP_KEY_FILE: source }, stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const result = JSON.parse(output);
    copy = result.path;
    expect(copy).not.toBe(source);
    expect(await readFile(copy!, "utf8")).toBe("public-entrypoint-test-key");
    expect((await lstat(copy!)).uid).toBe(0);
    expect((await lstat(copy!)).mode & 0o7777).toBe(0o400);
    expect((await lstat(dirname(copy!))).mode & 0o7777).toBe(0o700);
    for (const field of ["CapEff", "CapPrm"]) expect(BigInt(`0x${new RegExp(`${field}:\\s+(\\w+)`).exec(result.status)?.[1]}`)).toBe(0xe1n);
    expect(result.status).toMatch(/NoNewPrivs:\s+1/);
    expect(result.readExit).toBe(1);
    expect(result.errors.match(/Permission denied/g)).toHaveLength(2);
    expect(result.errors).toContain(source);
    expect(result.errors).toContain(copy!);
    expect(result.output).toBe("");
    expect((await lstat(source)).mode & 0o7777).toBe(0o444);
  } finally {
    if (copy) {
      await unlink(copy);
      await rmdir(dirname(copy));
    }
    await unlink(join(directory, "probe.sock")).catch(() => undefined);
    await unlink(source);
    await rmdir(directory);
  }
});

test("entrypoint refuses exposed source directories, symlinks and conflicting key inputs", async () => {
  const directory = await mkdtemp("/tmp/runner-entrypoint-invalid-");
  const source = join(directory, "source");
  const link = join(directory, "link");
  const run = async (file: string, raw?: string) => {
    const child = Bun.spawn([entrypoint, "/bin/true"], {
      env: { CLOUD_APP_KEY_FILE: file, ...(raw ? { CLOUD_APP_KEY: raw } : {}) },
      stdout: "ignore",
      stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(126);
    return error;
  };
  try {
    await Bun.write(source, "public-entrypoint-test-key");
    await chmod(directory, 0o755);
    expect(await run(source)).toContain("runner_key_source_requires_root_private_directory");
    await chmod(directory, 0o700);
    await symlink(source, link);
    expect(await run(link)).toContain("source");
    expect(await run(source, "public-conflicting-key")).toContain("runner_key_sources_must_not_both_be_set");
  } finally {
    await unlink(link).catch(() => undefined);
    await unlink(source);
    await rmdir(directory);
  }
});

test("entrypoint reads an operator-owned 0600 bind secret without changing the source", async () => {
  const directory = await mkdtemp("/tmp/runner-entrypoint-operator-");
  const source = join(directory, "source");
  let copy: string | undefined;
  try {
    await chmod(directory, 0o700);
    await Bun.write(source, "public-operator-key");
    await chmod(source, 0o600);
    await chown(source, 12345, 12345);
    const child = Bun.spawn([entrypoint, "/bin/sh", "-c", 'printf "%s" "$CLOUD_APP_KEY_FILE"'], {
      env: { CLOUD_APP_KEY_FILE: source },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    copy = output;
    expect(await readFile(copy, "utf8")).toBe("public-operator-key");
    expect((await lstat(copy)).uid).toBe(0);
    expect((await lstat(copy)).mode & 0o7777).toBe(0o400);
    expect((await lstat(source)).uid).toBe(12345);
    expect((await lstat(source)).mode & 0o7777).toBe(0o600);
  } finally {
    if (copy) {
      await unlink(copy);
      await rmdir(dirname(copy));
    }
    await unlink(source);
    await rmdir(directory);
  }
});
