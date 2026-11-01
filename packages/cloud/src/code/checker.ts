import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodeAnalysis } from "./checker-analysis";
import type { CodeCheckDiagnostic, CodeCheckRequest, CodeCheckResult, CodePermission } from "./checker-contract";
import { CODE_CHECK_LIMITS, CodeCheckLimitsSchema, CodeVersionManifestSchema } from "./checker-contract";
import { codeSdkHash } from "./sdk-hash";

/** Trusted executable paths provided by the runner image. isolate is mandatory and fails closed: no unsandboxed fallback.
 * compiler is the native tsgo binary (not its Node launcher); worker is code-check-worker.ts with its compiler libraries. */
export type CodeCheckHost =
  | { isolate: string; compiler: string; worker: string; bun: string }
  | {
      /** Core uses runner transport; no compiler or untrusted execution belongs in Core. */
      check: (request: CodeCheckRequest, signal?: AbortSignal) => Promise<CodeCheckResult>;
    };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const failure = (code: string, message: string, file: string): CodeCheckResult => ({
  ok: false,
  diagnostics: [{ code, message, file, line: 1, column: 1 }],
});
const permissionKey = (p: Pick<CodePermission, "operation" | "target">) =>
  JSON.stringify([p.operation, p.target?.type ?? null, p.target?.id ?? null]);

/** Authoritative Phase 1 check. tsgo, analysis and bundling each run in a scrubbed, network-denied child.
 * Wall time is shared; output is drained with a byte bound, RSS is polled on Linux, and cancellation reaps every child.
 * Source paths and contents are untrusted data. SDK and host paths must originate from the platform, never the Code author. */
export async function checkCode(request: CodeCheckRequest, host: CodeCheckHost, signal?: AbortSignal): Promise<CodeCheckResult> {
  if ("check" in host) return host.check(request, signal);
  const limits = CodeCheckLimitsSchema.parse(request.limits ?? CODE_CHECK_LIMITS);
  if (process.platform !== "linux") return failure("code_checker_unavailable", "Der Code-Prüfer benötigt Linux.", request.entry);
  if (signal?.aborted) return failure("code_check_cancelled", "Prüfung abgebrochen.", request.entry);
  if (Buffer.byteLength(JSON.stringify(request)) > limits.requestBytes)
    return failure("code_request_limit", "Der Prüfauftrag überschreitet die eingestellte Grenze.", request.entry);
  const names = Object.keys(request.files).sort();
  const validPath = (name: string) =>
    /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.tsx?$/.test(name) && !["sdk.d.ts", "sdk.ts", "sdk.tsx"].includes(name);
  if (!names.includes(request.entry) || names.some((name) => !validPath(name)))
    return failure("code_source_path", "Ungültige Quelldatei im Code-Projekt.", request.entry);
  if (names.length > limits.files || names.reduce((sum, name) => sum + Buffer.byteLength(request.files[name]!), 0) > limits.sourceBytes)
    return failure("code_source_limit", "Der Quelltext überschreitet die eingestellte Grenze.", request.entry);
  const directory = await mkdtemp(join(tmpdir(), "cloud-code-check-"));
  const deadline = performance.now() + limits.checkMs;
  const run = async (command: string[]) => {
    if (signal?.aborted) throw new Error("code_check_cancelled");
    if (performance.now() >= deadline) throw new Error("code_check_time_limit");
    const child = Bun.spawn([host.isolate, ...command], {
      cwd: directory,
      env: {},
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let reason: string | undefined;
    let outputBytes = 0;
    const stop = (code: string) => {
      reason ??= code;
      child.kill("SIGKILL");
    };
    const cancel = () => stop("code_check_cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => stop("code_check_time_limit"), Math.max(1, deadline - performance.now()));
    let readingMemory = false;
    const memory = setInterval(async () => {
      if (readingMemory) return;
      readingMemory = true;
      try {
        const status = await readFile(`/proc/${child.pid}/status`, "utf8");
        const kb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
        if (kb * 1024 > limits.memoryBytes) stop("code_check_memory_limit");
      } catch {
        /* Child has exited. */
      } finally {
        readingMemory = false;
      }
    }, 20);
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          outputBytes += value.byteLength;
          if (outputBytes > limits.outputBytes) {
            stop("code_check_output_limit");
            continue;
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    try {
      const [exit, stdout, stderr] = await Promise.all([child.exited, drain(child.stdout), drain(child.stderr)]);
      if (reason) throw new Error(reason);
      return { exit, stdout, stderr };
    } finally {
      clearTimeout(timer);
      clearInterval(memory);
      signal?.removeEventListener("abort", cancel);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  };
  try {
    for (const name of names) {
      const path = join(directory, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, request.files[name]!, { mode: 0o600 });
    }
    await writeFile(join(directory, "sdk.d.ts"), request.sdk.declarations);
    const requestPath = join(directory, "request.json");
    await writeFile(requestPath, JSON.stringify({ ...request, limits }), { mode: 0o600 });
    const analysisProcess = await run([host.bun, "--no-env-file", host.worker, "analyze", requestPath]);
    if (analysisProcess.exit !== 0) throw new Error("code_analysis_failed");
    const analysis: CodeAnalysis = JSON.parse(analysisProcess.stdout);
    if (analysis.diagnostics.length) return { ok: false, diagnostics: analysis.diagnostics };
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          target: "esnext",
          module: "preserve",
          moduleResolution: "bundler",
          types: [],
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          paths: { "@sdk": ["./sdk.d.ts"] },
        },
        files: names,
      }),
    );
    const types = await run([host.compiler, "--checkers", "1", "--project", join(directory, "tsconfig.json"), "--pretty", "false"]);
    if (types.exit !== 0) {
      const diagnostics: CodeCheckDiagnostic[] = types.stdout.split("\n").flatMap((line) => {
        const match = /^(.*?)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line.trim());
        return match
          ? [
              {
                code: `TS${match[4]}`,
                message: match[5]!,
                file: match[1]!.replace(`${directory}/`, ""),
                line: Number(match[2]),
                column: Number(match[3]),
              },
            ]
          : [];
      });
      return diagnostics.length
        ? { ok: false, diagnostics }
        : failure("code_typecheck_failed", "Typprüfung fehlgeschlagen.", request.entry);
    }
    await writeFile(requestPath, JSON.stringify({ ...request, limits, entrypoints: analysis.entrypoints }), { mode: 0o600 });
    const built = await run([host.bun, "--no-env-file", host.worker, "bundle", requestPath]);
    if (built.exit !== 0) throw new Error(built.stderr.includes("code_bundle_limit") ? "code_bundle_limit" : "code_bundle_failed");
    const { bundle, modules }: { bundle: string; modules: string[] } = JSON.parse(built.stdout);
    if (JSON.stringify([...analysis.modules].sort()) !== JSON.stringify([...modules].sort()))
      return failure(
        "code_import_elided",
        "Bundler und Analyse sind sich über die geladenen Module uneinig. Prüfe die Importe und versuche es erneut.",
        request.entry,
      );
    if (Buffer.byteLength(bundle) > limits.bundleBytes) throw new Error("code_bundle_limit");
    const manifest = CodeVersionManifestSchema.parse({
      version: 1,
      entrypoints: analysis.entrypoints,
      permissions: analysis.permissions,
      ai: analysis.ai,
      ...(analysis.internet ? { internet: true } : {}),
      hashes: {
        source: sha256(JSON.stringify({ entry: request.entry, files: names.map((name) => [name, request.files[name]]) })),
        sdk: codeSdkHash(request.sdk),
        bundle: sha256(bundle),
      },
    });
    const existing = new Set(request.existingPermissions?.map(permissionKey));
    return {
      ok: true,
      diagnostics: [],
      bundle,
      manifest,
      permissions: manifest.permissions.map((p) => ({ ...p, status: existing.has(permissionKey(p)) ? "existing" : "new" })),
    };
  } catch (error) {
    const code = error instanceof Error && /^code_[a-z_]+$/.test(error.message) ? error.message : "code_check_failed";
    return failure(
      code,
      code === "code_check_time_limit"
        ? "Prüfung hat die Zeitgrenze erreicht. Vereinfache die Typen oder erhöhe die Admin-Grenze."
        : `Prüfung fehlgeschlagen (${code}).`,
      request.entry,
    );
  } finally {
    async function clean(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await clean(child);
        else await unlink(child);
      }
      await rmdir(path);
    }
    await clean(directory);
  }
}
