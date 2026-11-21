import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

let launcher: Promise<string> | undefined;

/** Called at module load by checker suites, never from a timed test or hook. */
export function getCheckerIsolate(): Promise<string> {
  launcher ??= compileLauncher();
  return launcher;
}

async function compileLauncher(): Promise<string> {
  const native = resolve(import.meta.dir, "../../packages/runner/native");
  const flags = ["-O2", "-Wall", "-Wextra", "-Werror"];
  const hash = createHash("sha256").update(JSON.stringify([process.platform, process.arch, flags]));
  for (const source of ["checker-isolate.c", "namespace-filter.h"]) hash.update(await readFile(join(native, source)));
  const uid = userInfo().uid;
  const directory = join(tmpdir(), `cloud-checker-isolate-${uid}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
    throw new Error("checker-isolate cache directory must be private and owned by the current user");
  }
  const isolate = join(directory, hash.digest("hex"));
  try {
    const cached = await lstat(isolate);
    if (!cached.isFile() || cached.uid !== uid || (cached.mode & 0o100) === 0) {
      throw new Error("checker-isolate cache entry must be an executable file owned by the current user");
    }
    return isolate;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  // Parallel test processes may miss the same cache entry. Only a finished binary is
  // published; renaming also leaves any process executing the previous inode alone.
  const temporary = `${isolate}.${process.pid}.${crypto.randomUUID()}`;
  try {
    const compiler = Bun.spawn(["cc", ...flags, join(native, "checker-isolate.c"), "-o", temporary], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([compiler.exited, new Response(compiler.stderr).text()]);
    if (exit !== 0 || stderr !== "") throw new Error(`checker-isolate compilation failed (${exit}): ${stderr}`);
    await rename(temporary, isolate);
    return isolate;
  } finally {
    await rm(temporary, { force: true });
  }
}
