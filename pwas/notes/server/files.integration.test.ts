import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { SQL } from "bun";
import * as Y from "yjs";
import { createDisposableDatabase, databaseSuite } from "../../../scripts/fixtures/test-infra";
import { createNotesApp } from "./app";
import { migrate } from "./database";
import { readUpload } from "./files";
import { limits } from "./limits";
import { NotesService } from "./service";
import { NotesStore } from "./store";

const origin = "https://notes.example.test";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV2cAAAAASUVORK5CYII=", "base64");
const form = (key = "image", bytes: Uint8Array = image, type = "text/html") => {
  const form = new FormData();
  form.set("key", key);
  form.set("file", new File([Uint8Array.from(bytes).buffer], "camera.png", { type }));
  return form;
};
const options = { origin, storageBytes: 1024 ** 3, maxConnections: 50, maxOpenPads: 10 };

databaseSuite()("Notes file transport and persistence", () => {
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let db: SQL;
  let service: NotesService;
  let links: { readId: string; editId: string };
  let app: ReturnType<typeof createNotesApp>;
  beforeAll(async () => {
    database = await createDisposableDatabase("notes_files");
    db = new SQL(database.url);
    await migrate(db);
  });
  beforeEach(async () => {
    setSystemTime(new Date("2026-10-30T12:00:00Z"));
    service = new NotesService(new NotesStore(db, options.storageBytes), options);
    await service.start();
    const doc = new Y.Doc();
    doc.clientID = 1;
    doc.getText("text").insert(0, "files");
    links = await service.create(Y.encodeStateAsUpdate(doc), "192.0.2.1");
    doc.destroy();
    app = createNotesApp(async () => true, service, options);
  });
  afterEach(async () => {
    await service.stop();
    await db`TRUNCATE pads CASCADE`;
  });
  afterAll(async () => {
    setSystemTime();
    await db.close();
    await database.drop();
  });
  const upload = (token = links.editId, data = form()) =>
    app.request(`/api/pads/${token}/files`, { method: "POST", headers: { Origin: origin }, body: data });

  test("content decides the MIME type and both capabilities can read images", async () => {
    expect((await upload()).status).toBe(201);
    for (const token of [links.readId, links.editId]) {
      const response = await app.request(`/api/pads/${token}/files/image`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      expect(response.headers.get("Content-Disposition")).toStartWith("inline;");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
    }
    expect((await upload(links.readId, form("reader"))).status).toBe(403);
  });
  test("SVG is refused and PDFs are forced to download", async () => {
    expect(
      (
        await upload(
          links.editId,
          form("svg", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'), "image/png"),
        )
      ).status,
    ).toBe(415);
    expect((await upload(links.editId, form("pdf", new TextEncoder().encode("%PDF-1.7\n%%EOF\n")))).status).toBe(201);
    const response = await app.request(`/api/pads/${links.readId}/files/pdf`);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toStartWith("attachment;");
  });
  test("retries do not consume another file slot or storage reservation", async () => {
    expect((await upload()).status).toBe(201);
    const used = (await service.store.status()).usedBytes;
    expect((await upload()).status).toBe(201);
    expect((await service.store.status()).usedBytes).toBe(used);
    expect((await upload(links.editId, form("image", Buffer.concat([image, Buffer.from("different")])))).status).toBe(409);
  });
  test("concurrent uploads stop atomically at twenty and survive a restart", async () => {
    const checked = await readUpload(new Request(`${origin}/upload`, { method: "POST", body: form() }));
    const results = await Promise.allSettled(
      Array.from({ length: 22 }, (_, index) => service.upload(links.editId, { ...checked, key: `file_${index}` })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(limits.files);
    const used = (await service.store.status()).usedBytes;
    await service.stop();
    service = new NotesService(new NotesStore(db, options.storageBytes), options);
    await service.start();
    expect((await service.store.status()).usedBytes).toBe(used);
    expect(Buffer.from((await service.store.getFile(links.readId, "file_0")).bytes)).toEqual(image);
  });
  test("bounded bodies and per-connection upload limits reject before persistence", async () => {
    const oversized = new Uint8Array(limits.fileBytes + 1);
    oversized.set(image);
    expect((await upload(links.editId, form("large", oversized))).status).toBe(413);
    for (let index = 1; index < limits.uploadPerHour; index++) expect((await upload()).status).toBe(201);
    expect((await upload()).status).toBe(429);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(limits.fileBytes + 16_385));
        controller.close();
      },
    });
    await expect(
      readUpload(
        new Request(`${origin}/upload`, { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: stream }),
      ),
    ).rejects.toMatchObject({ code: "body_limit" });
  });
  test("permissions are checked before reading uploads and the global transfer budget rejects excess work", async () => {
    const readonlyRequest = new Request(`${origin}/api/pads/${links.readId}/files`, {
      method: "POST",
      headers: { Origin: origin },
      body: form(),
    });
    expect((await app.fetch(readonlyRequest)).status).toBe(403);
    expect(readonlyRequest.bodyUsed).toBe(false);
    setSystemTime(new Date("2026-10-30T13:00:01Z"));
    service.rates.prune();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let count = 0;
    const editablePad = service.store.editablePad.bind(service.store);
    service.store.editablePad = async (token) => {
      if (++count === options.maxOpenPads) entered();
      await gate;
      return editablePad(token);
    };
    const pending = Array.from({ length: options.maxOpenPads }, () => upload());
    try {
      await ready;
      expect((await app.request(`/api/pads/${links.readId}/files/image`)).status).toBe(503);
      release();
      const completed = await Promise.all(pending);
      expect(completed.filter((result) => result.status === 201)).toHaveLength(limits.uploadPerHour);
      expect((await app.request(`/api/pads/${links.readId}/files/image`)).status).toBe(200);
    } finally {
      release();
      await Promise.allSettled(pending);
      service.store.editablePad = editablePad;
    }
  });
  test("aborting a stalled upload releases its reader", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const reading = readUpload(
      new Request(origin, {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=x" },
        body: stream,
        signal: controller.signal,
      }),
    );
    controller.abort();
    await expect(reading).rejects.toMatchObject({ code: "request_aborted" });
    expect(cancelled).toBe(true);
  });
  test("deletion fences late uploads and removes the stored bytes", async () => {
    const checked = await readUpload(new Request(`${origin}/upload`, { method: "POST", body: form() }));
    await Promise.allSettled([service.remove(links.editId), service.upload(links.editId, checked)]);
    expect((await app.request(`/api/pads/${links.readId}/files/image`)).status).toBe(410);
    const [row] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM pad_files`;
    expect(row!.count).toBe(0);
  });
});
