import { join } from "node:path";
import { z } from "zod";
import type { Runtime } from "../../../../scripts/perf-baseline/runtime";
import { anchor } from "../../test/fixtures/large-mailbox";
import { assertRunUrl } from "./measure";

const commitSchema = z.object({ enqueuedAt: z.number(), committedAt: z.number(), conversationId: z.string() });
export type ArrivalCommit = z.infer<typeof commitSchema>;

/**
 * One message ingested through ingestEnvelope by a host worker against this run's database.
 * Times are host epoch milliseconds (performance.timeOrigin + performance.now()).
 */
export class Arrival {
  committed: ArrivalCommit | undefined;
  failure: string | null = null;
  private readonly child: ReturnType<typeof Bun.spawn>;
  private readonly stderr: Promise<string>;
  private settle: (() => void) | null = null;

  constructor(options: {
    signal: AbortSignal;
    runtime: Runtime;
    origin: string;
    mailboxId: string;
    remoteResourceId: string;
    folderId: string;
    uid: number;
  }) {
    const postgresPort = options.runtime.published.postgres,
      valkeyPort = options.runtime.published.valkey;
    const databaseUrl = assertRunUrl(
      `postgresql://ipa:ipa@127.0.0.1:${postgresPort}/cloud_perf_test`,
      postgresPort,
      "postgresql:",
      "cloud_perf_test",
    );
    const redisUrl = assertRunUrl(`redis://127.0.0.1:${valkeyPort}`, valkeyPort, "redis:");
    this.child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "ingest-worker.ts")], {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        APP_URL: options.origin,
        APP_ID: "mail",
        NODE_ENV: "production",
      },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      signal: options.signal,
      timeout: 30_000,
      ipc: (message) => {
        const parsed = commitSchema.safeParse(message);
        if (parsed.success) this.committed = parsed.data;
        else this.failure = "Malformed ingest worker response";
        this.settle?.();
      },
    });
    if (!this.child.stdin || typeof this.child.stdin === "number") throw new Error("Missing ingest stdin");
    this.child.stdin.write(
      JSON.stringify({
        mailboxId: options.mailboxId,
        remoteResourceId: options.remoteResourceId,
        folderId: options.folderId,
        uid: options.uid,
        anchor,
        postgresPort,
        valkeyPort,
      }),
    );
    this.child.stdin.end();
    if (!this.child.stderr || typeof this.child.stderr === "number") throw new Error("Missing ingest stderr");
    this.stderr = new Response(this.child.stderr).text();
  }

  /** Resolves once the worker reported a commit or a malformed reply, or exited. */
  async settled() {
    await Promise.race([
      new Promise<void>((resolve) => {
        this.settle = resolve;
        if (this.committed || this.failure) resolve();
      }),
      this.child.exited,
    ]);
  }

  get exited() {
    return this.child.exitCode !== null;
  }

  /** Throws with the worker's stderr when it exited without reporting a commit. */
  async requireCommit(): Promise<ArrivalCommit> {
    if (this.committed) return this.committed;
    throw new Error(`Ingest failed (${await this.child.exited}): ${(await this.stderr).slice(-1000)}`);
  }

  async finish() {
    const code = await this.child.exited;
    const stderr = await this.stderr;
    if (code !== 0) throw new Error(`Ingest worker exited ${code}: ${stderr.slice(-1000)}`);
  }

  async dispose() {
    if (this.child.exitCode === null) this.child.kill();
    await this.child.exited;
  }
}
