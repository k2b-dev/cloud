import { afterAll, describe, expect, test } from "bun:test";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { bindProcessApplicationId, clearProcessApplicationId, getProcessApplicationId } from "../_internal/process-identity";
import { servePublicStorage } from "../server/public-storage";
import { type ObjectStoreFile, storage } from "./object-store";
import { set } from "./settings";
import { useTestSettings } from "./settings/settings.test-fixture";

const suite = suiteFor("s3", "database", "valkey");
suite("platform object store against S3", () => {
  const previousId = getProcessApplicationId();
  useTestSettings({
    "storage.endpoint": process.env.CLOUD_TEST_S3_ENDPOINT,
    "storage.region": process.env.CLOUD_TEST_S3_REGION,
    "storage.bucket": process.env.CLOUD_TEST_S3_BUCKET,
    "storage.access_key_id": process.env.CLOUD_TEST_S3_ACCESS_KEY_ID,
    "storage.secret_access_key": process.env.CLOUD_TEST_S3_SECRET_ACCESS_KEY,
    "storage.max_object_bytes": 32 * 1024 ** 2,
    "app.url": "https://cloud.example.test",
  });
  describe("package objects", () => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const appA = `store-a-${suffix}`;
    const appB = `store-b-${suffix}`;
    const files: ObjectStoreFile[] = [];
    const inApp = (id: string, packageName = id) => {
      clearProcessApplicationId();
      bindProcessApplicationId(id, [], packageName);
    };
    const tracked = (key: string, visibility: "private" | "public" = "private") => {
      const file = (visibility === "public" ? storage.public : storage).file(key);
      files.push(file);
      return file;
    };
    afterAll(async () => {
      try {
        await Promise.all(files.map((file) => file.delete()));
      } finally {
        clearProcessApplicationId();
        if (previousId) bindProcessApplicationId(previousId);
      }
    });

    test("apps in one package share private documents, copying, listing and public images", async () => {
      const group = `shared-${suffix}`;
      inApp(appA, group);
      const document = tracked("shared.pdf");
      await document.write("shared", { type: "application/pdf" });
      const image = tracked("shared.png", "public");
      await image.write(new Blob(["image"], { type: "image/png" }));
      inApp(appB, group);
      expect(await storage.file("shared.pdf").text()).toBe("shared");
      expect((await storage.list()).contents?.map((item) => item.key)).toEqual(["shared.pdf"]);
      expect(await storage.public.file("shared.png").exists()).toBe(true);
      expect(await storage.public.file("shared.png").url).toContain(`/public/storage/${group}/shared.png`);
      const copied = tracked("shared-copy.pdf");
      await storage.file("shared.pdf").copy(copied.key);
      expect(await copied.text()).toBe("shared");
      await storage.file("shared.pdf").delete();
      expect(await document.exists()).toBe(false);
    });

    test("isolates two apps, both visibility parts, metadata, copying, listing, and signed requests", async () => {
      inApp(appB);
      const victim = tracked("secret.txt");
      await victim.write("app B private document", { type: "text/plain" });
      inApp(appA);
      const own = tracked("secret.txt");
      const publicImage = tracked("images/café.png", "public");
      expect(await own.exists()).toBe(false);
      expect(await own.write("app A private document", { type: "text/plain" })).toBe(22);
      await publicImage.write(new Uint8Array([1, 2, 3]), { type: "image/png" });
      expect(await own.text()).toBe("app A private document");
      expect(await own.bytes()).toEqual(new TextEncoder().encode("app A private document"));
      expect(await new Response(own.stream()).text()).toBe("app A private document");
      expect(await own.size).toBe(22);
      expect((await own.stat()).size).toBe(22);
      expect((await own.stat()).type).toStartWith("text/plain");
      const copied = tracked("copies/document.txt");
      expect(await own.copy(copied.key)).toBe(22);
      expect(await copied.text()).toBe(await own.text());
      const privateKeys = (await storage.list()).contents?.map((item) => item.key).sort();
      expect(privateKeys).toEqual(["copies/document.txt", "secret.txt"]);
      expect((await storage.list({ prefix: "copies/" })).contents?.map((item) => item.key)).toEqual(["copies/document.txt"]);
      expect((await storage.public.list()).contents?.map((item) => item.key)).toEqual(["images/café.png"]);
      expect(await storage.file(publicImage.key).exists()).toBe(false);
      const first = await storage.list({ maxKeys: 1 });
      expect(first.isTruncated).toBe(true);
      expect(first.nextContinuationToken).toBeDefined();
      const second = await storage.list({ maxKeys: 1, continuationToken: first.nextContinuationToken });
      expect(second.contents?.length).toBe(1);
      expect(second.contents?.[0]?.key).not.toBe(first.contents?.[0]?.key);
      expect((await storage.list({ startAfter: "copies/document.txt" })).contents?.map((item) => item.key)).toEqual(["secret.txt"]);

      const signed = await own.presign();
      const url = new URL(signed);
      expect(decodeURIComponent(url.pathname)).toEndWith(`/private/${appA}/secret.txt`);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
      const response = await fetch(signed);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("app A private document");
      const head = await fetch(await own.presign({ method: "HEAD" }), { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe("22");
      const tampered = new URL(signed);
      tampered.pathname = tampered.pathname.replace(`/private/${appA}/`, `/private/${appB}/`);
      const denied = await fetch(tampered);
      expect(denied.ok).toBe(false);
      await denied.body?.cancel();

      for (const key of ["../../" + appB + "/private/secret.txt", "../../../secret.txt", "%2e%2e/%2fsecret", "x/../secret.txt"]) {
        expect(() => storage.file(key)).toThrow();
        await expect(storage.list({ prefix: key })).rejects.toThrow();
        await expect(own.copy(key)).rejects.toThrow();
      }
      // WHATWG fetch normalizes this path, then S3 rejects the invalidated signature.
      const normalization = signed.replace(`/private/${appA}/`, `/private/${appA}/../${appB}/`);
      const normalized = new Request(normalization);
      expect(new URL(normalized.url).pathname).toEndWith(`/private/${appB}/secret.txt`);
      const normalizationResponse = await fetch(normalized);
      expect(normalizationResponse.ok).toBe(false);
      await normalizationResponse.body?.cancel();

      const nested = tracked(`packages/${appB}/private/secret.txt`);
      await nested.write("still inside app A");
      expect(await victim.text()).toBe("app B private document");
      inApp(appB);
      expect((await storage.list()).contents?.map((item) => item.key)).toEqual(["secret.txt"]);
      const foreignToken = await storage.list({ continuationToken: first.nextContinuationToken });
      expect(foreignToken.contents?.every((item) => item.key === "secret.txt") ?? true).toBe(true);
      expect((await storage.public.list()).contents ?? []).toEqual([]);
      expect(await storage.file("copies/document.txt").exists()).toBe(false);
      await own.delete();
      expect(await own.exists()).toBe(false);
      expect(await victim.text()).toBe("app B private document");
      const deletion = await fetch(await copied.presign({ method: "DELETE" }), { method: "DELETE" });
      expect(deletion.ok).toBe(true);
      await deletion.body?.cancel();
      expect(await copied.exists()).toBe(false);
    });

    test("anonymous delivery serves public files and never private files or encoded traversal", async () => {
      inApp(appA);
      const image = tracked("web/picture.png", "public");
      await image.write("image", { type: "image/png" });
      const response = await servePublicStorage(new Request(await image.url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("etag")).toBeTruthy();
      expect(await response.text()).toBe("image");
      const head = await servePublicStorage(new Request(await image.url, { method: "HEAD" }));
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const active = tracked("web/page.svg", "public");
      await active.write("<svg/>", { type: "image/svg+xml" });
      const download = await servePublicStorage(new Request(await active.url));
      expect(download.headers.get("content-disposition")).toBe("attachment");
      expect(download.headers.get("content-security-policy")).toContain("sandbox");
      expect(download.headers.get("x-content-type-options")).toBe("nosniff");
      await download.body?.cancel();
      const privateFile = tracked("private-only.txt");
      await privateFile.write("private");
      const hidden = await servePublicStorage(new Request(`https://cloud.example.test/public/storage/${appA}/private-only.txt`));
      expect(hidden.status).toBe(404);
      for (const key of ["%252e%252e/private-only.txt", "x%2f..%2fprivate-only.txt", "x/%2e%2e/private-only.txt"]) {
        const denied = await servePublicStorage(new Request(`https://cloud.example.test/public/storage/${appA}/${key}`));
        expect(denied.status).toBe(404);
      }
    });

    test("enforces the configured byte limit before replacing an existing S3 object", async () => {
      inApp(appA);
      await set("storage.max_object_bytes", 5);
      try {
        const file = tracked("limited.txt");
        await file.write("first");
        await expect(file.write("second")).rejects.toThrow("5-byte");
        await expect(file.write(new Response("too much"))).rejects.toThrow("5-byte");
        expect(await file.text()).toBe("first");
        expect(await file.size).toBe(5);
      } finally {
        await set("storage.max_object_bytes", 32 * 1024 ** 2);
      }
    });
  });
});
