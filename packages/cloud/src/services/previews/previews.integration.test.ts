import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Worker } from "@k2b/sync";
import sharp from "sharp";
import { requireInfraUrl, suiteFor, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { type ProcessSync, startProcessSync } from "../../_internal/process-sync";
import { visionPdfFixture } from "../../ai/pdf-render.fixture";
import { sql } from "../../runtime/clients";
import { convertOfficeToPdf } from "../pdf/gotenberg";
import { generatePreview } from "./generate";
import { createPreviewsService } from "./service";
import { createPreviewsStore, previewJobKey, setupPreviews } from "./store";
import { type PreviewSource, PreviewSourceChanged } from "./types";

suiteFor("database", "nats")("platform previews", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  let sync: ProcessSync;
  let worker: Worker;
  let service: ReturnType<typeof createPreviewsService>;
  let store: ReturnType<typeof createPreviewsStore>;
  const objects = new Map<string, Blob>();
  const inputs = new Map<string, Uint8Array>();
  const source = (key: string, name: string): PreviewSource => ({
    key,
    revision: "r1",
    locator: key,
    name,
    size: inputs.get(key)?.byteLength ?? 0,
  });
  beforeAll(async () => {
    fresh = await useFreshDatabase("platform_previews");
    await Promise.all([setupPreviews(sql), setupPreviews(sql)]);
    sync = await startProcessSync({ application: "preview-fixture" });
    const job = sync.sync.job<PreviewSource>({
      id: "previews",
      maxPayloadBytes: 8192,
      retention: { maxMessages: 64, maxBytes: 64 * 8192, maxAgeMs: 4 * 60 * 60_000 },
      whenFull: "reject",
      delivery: { maxAttempts: 1, ackWaitMs: 210_000 },
    });
    store = createPreviewsStore(sql, "preview-fixture");
    service = createPreviewsService({
      store,
      persistent: async () => true,
      generate: generatePreview,
      object: (key) => ({
        async write(blob) {
          objects.set(key, blob);
        },
        async delete() {
          objects.delete(key);
        },
        exists: async () => objects.has(key),
        stream: () => objects.get(key)!.stream(),
      }),
      async submit(input) {
        await job.submit({ key: previewJobKey(input), input, coalesce: true });
      },
    });
    service.reader(async (input) => {
      const bytes = inputs.get(input.key);
      if (!bytes) throw new PreviewSourceChanged();
      return new Response(new Uint8Array(bytes));
    });
    worker = await job.process({ concurrency: 2 }, (context) => service.work(context.input, context.signal));
  });
  beforeEach(async () => {
    await sql`TRUNCATE platform._cloud_previews`;
    objects.clear();
    inputs.clear();
  });
  afterAll(async () => {
    worker?.stop();
    await service?.stop();
    await worker?.drain();
    await sync?.stop();
    await sql.close();
    await fresh?.drop();
  });
  async function settled(input: PreviewSource) {
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      const result = await service.read(input, "small");
      if (result.state !== "pending") return result;
      await Bun.sleep(25);
    }
    throw new Error("Preview did not settle within the integration test deadline");
  }
  test("idempotent table setup and real PNG/PDF jobs produce both JPEG variants", async () => {
    inputs.set(
      "png",
      new Uint8Array(
        await sharp({ create: { width: 20, height: 10, channels: 4, background: "red" } })
          .png()
          .toBuffer(),
      ),
    );
    inputs.set("pdf", visionPdfFixture());
    for (const [key, name] of [
      ["png", "image.png"],
      ["pdf", "document.pdf"],
    ]) {
      const input = source(key!, name!);
      expect((await service.read(input, "small")).state).toBe("pending");
      const result = await settled(input);
      expect(result.state).toBe("ready");
      if (result.state !== "ready") throw new Error("Expected ready preview");
      expect(result.type).toBe("image/jpeg");
      const small = await sharp(await new Response(result.body).bytes()).metadata();
      expect(small.width).toBeLessThanOrEqual(key === "png" ? 20 : 320);
      expect((await service.read(input, "large")).state).toBe("ready");
    }
    await setupPreviews(sql);
    expect(objects.size).toBe(4);
  }, 30_000);
  test("failed state survives views until retry, then the corrected source succeeds", async () => {
    inputs.set("broken", new TextEncoder().encode("invalid PNG"));
    const input = source("broken", "image.png");
    expect((await settled(input)).state).toBe("failed");
    inputs.set(
      "broken",
      new Uint8Array(
        await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } })
          .png()
          .toBuffer(),
      ),
    );
    expect((await service.read(input, "small")).state).toBe("failed");
    await service.retry(input);
    expect((await settled(input)).state).toBe("ready");
  }, 30_000);
  test("installation budget ranks all packages and deletes only the local package's objects", async () => {
    inputs.set(
      "local",
      new Uint8Array(
        await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } })
          .png()
          .toBuffer(),
      ),
    );
    const input = source("local", "image.png");
    expect((await settled(input)).state).toBe("ready");
    const other = createPreviewsStore(sql, "other-app");
    await other.put({ ...input, key: "foreign" }, "ready", { text: { type: "text/plain", bytes: 100 } });
    await sql`UPDATE platform._cloud_previews SET shown_at='2026-01-01T00:00:00Z' WHERE package='preview-fixture'`;
    await sql`UPDATE platform._cloud_previews SET shown_at='2026-01-02T00:00:00Z' WHERE package='other-app'`;
    expect(await service.maintain(100, new AbortController().signal)).toBe(1);
    expect(objects.size).toBe(0);
    expect(await store.find(input)).toBeNull();
    expect((await other.find({ ...input, key: "foreign" }))?.state).toBe("ready");
  }, 30_000);
  test("remembered failures expire after 30 days, only the local package's", async () => {
    const failed = source("expired", "broken.png");
    await store.put(failed, "failed", {}, "generation_failed");
    const other = createPreviewsStore(sql, "other-app");
    await other.put({ ...failed, key: "foreign-failed" }, "failed", {}, "generation_failed");
    await sql`UPDATE platform._cloud_previews SET created_at=statement_timestamp() - interval '31 days' WHERE state='failed'`;
    expect(await service.maintain(1_000_000_000, new AbortController().signal)).toBe(1);
    expect(await store.find(failed)).toBeNull();
    expect((await other.find({ ...failed, key: "foreign-failed" }))?.state).toBe("failed");
  }, 30_000);
});

suiteFor(
  "database",
  "valkey",
  "gotenberg",
)("Office preview conversion", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    fresh = await useFreshDatabase("office_previews");
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE settings.entries (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz DEFAULT now(), updated_by uuid)`.simple();
    const { set } = await import("../settings");
    await set("gotenberg.url", requireInfraUrl("gotenberg"));
  });
  afterAll(async () => {
    await sql.close();
    await fresh?.drop();
  });
  test("the full Gotenberg image converts RTF through LibreOffice", async () => {
    const result = await convertOfficeToPdf({ name: "example.rtf", data: new Blob(["{\\rtf1\\ansi Cloud preview}"]) });
    expect(new TextDecoder().decode(result.pdf.slice(0, 5))).toBe("%PDF-");
  }, 30_000);
});
