import { expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { NetworkTargetBlockedError } from "@k2b/cloud/services/network-security";
import { parseNetworkAllowlist } from "@k2b/cloud/shared";
import { defaultS3Uploader, type NotebookBackupConfig, type NotebookBackupObject } from "./backup";
import { presignSnapshotObject, uploadSnapshotObjects } from "./snapshot-http";

const config: NotebookBackupConfig = {
  enabled: true,
  configured: true,
  missing: [],
  prefix: "notebooks",
  endpoint: "",
  region: "us-east-1",
  bucket: "bucket",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
};
const objects: NotebookBackupObject[] = [
  { path: "notebooks/nb1234/latest.zip", contentType: "application/zip", content: new Uint8Array([0, 1, 255]) },
  { path: "notebooks/nb1234/snapshots/2026-05-28T14-30-05-123Z.zip", contentType: "application/zip", content: new Uint8Array([0, 1, 255]) },
  { path: "notebooks/nb1234/latest-manifest.json", contentType: "application/json", content: '{"name":"Notizbücher"}' },
];
const withServer = async (handler: (req: IncomingMessage, res: ServerResponse) => void, run: (port: number) => Promise<void>) => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    await run(address.port);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
};

test("default uploader refuses internal literal endpoints without sending objects", async () => {
  const original = process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS;
  delete process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS;
  let received = 0;
  try {
    await withServer(
      (_req, res) => {
        received++;
        res.end();
      },
      async (port) => {
        for (const host of ["127.0.0.1", "[::ffff:127.0.0.1]"]) {
          await expect(defaultS3Uploader({ ...config, endpoint: `http://${host}:${port}` }, objects)).rejects.toBeInstanceOf(
            NetworkTargetBlockedError,
          );
        }
        expect(received).toBe(0);
      },
    );
  } finally {
    if (original === undefined) delete process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS;
    else process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS = original;
  }
});

test("failed and empty lookup answers send nothing", async () => {
  let received = 0;
  await withServer(
    (_req, res) => {
      received++;
      res.end();
    },
    async (port) => {
      for (const lookup of [
        async () => {
          throw new Error("Lookup failed");
        },
        async () => [],
      ]) {
        await expect(
          uploadSnapshotObjects({ ...config, endpoint: `http://snapshots.test:${port}` }, objects, {
            allowlist: parseNetworkAllowlist(["snapshots.test"]),
            lookup,
          }),
        ).rejects.toThrow();
      }
      expect(received).toBe(0);
    },
  );
});

for (const host of ["127.0.0.1", "snapshots.test"]) {
  test(`allowed ${host} receives three signed PUT objects through the checked address`, async () => {
    const received: Array<{ method?: string; host?: string; type?: string; length?: string; url: URL; body: Buffer }> = [];
    let lookups = 0;
    await withServer(
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          received.push({
            method: req.method,
            host: req.headers.host,
            type: req.headers["content-type"],
            length: req.headers["content-length"],
            url: new URL(req.url!, `http://${req.headers.host}`),
            body: Buffer.concat(chunks),
          });
          res.writeHead(200);
          res.end();
        });
      },
      async (port) => {
        const uploaded = await uploadSnapshotObjects({ ...config, endpoint: `http://${host}:${port}` }, objects, {
          allowlist: parseNetworkAllowlist([host]),
          lookup: async (hostname) => {
            expect(hostname).toBe(host);
            lookups++;
            return [{ address: "127.0.0.1", family: 4 }];
          },
        });
        expect(lookups).toBe(host === "snapshots.test" ? 1 : 0);
        expect(received).toHaveLength(3);
        for (const [index, item] of received.entries()) {
          const object = objects[index]!;
          const body = Buffer.from(object.content);
          expect(item.method).toBe("PUT");
          expect(item.host).toBe(`${host}:${port}`);
          expect(item.url.pathname).toBe(`/bucket/${object.path}`);
          expect(item.type).toBe(object.contentType);
          expect(item.length).toBe(String(body.length));
          expect(item.body).toEqual(body);
          expect(item.url.searchParams.has("X-Amz-Signature")).toBe(true);
          expect(item.url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
          expect(item.url.searchParams.has("response-content-type")).toBe(false);
          expect(uploaded[index]).toEqual({ path: object.path, bytes: body.length });
        }
      },
    );
  });
}

test("a 2xx answer completes the upload even when the endpoint never ends its body", async () => {
  let requests = 0;
  await withServer(
    (req, res) => {
      requests++;
      req.resume();
      req.on("end", () => {
        res.writeHead(200);
        res.write("still sending");
      });
    },
    async (port) => {
      expect(
        await uploadSnapshotObjects({ ...config, endpoint: `http://127.0.0.1:${port}` }, objects, {
          allowlist: parseNetworkAllowlist(["127.0.0.1"]),
        }),
      ).toHaveLength(3);
      expect(requests).toBe(3);
    },
  );
});

test("redirects fail without requesting the Location", async () => {
  let requests = 0;
  await withServer(
    (_req, res) => {
      requests++;
      res.writeHead(307, { Location: "/redirected" });
      res.end();
    },
    async (port) => {
      await expect(
        uploadSnapshotObjects({ ...config, endpoint: `http://127.0.0.1:${port}` }, objects, {
          allowlist: parseNetworkAllowlist(["127.0.0.1"]),
        }),
      ).rejects.toThrow("HTTP 307");
      expect(requests).toBe(1);
    },
  );
});

test("S3 XML failures preserve the provider code and readable reason", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(403);
      res.end("<Error><Code>AccessDenied</Code><Message>Check bucket &amp; key permissions.</Message></Error>");
    },
    async (port) => {
      await expect(
        uploadSnapshotObjects({ ...config, endpoint: `http://127.0.0.1:${port}` }, objects, {
          allowlist: parseNetworkAllowlist(["127.0.0.1"]),
        }),
      ).rejects.toThrow("AccessDenied: Check bucket & key permissions.");
    },
  );
});

test("provider errors are bounded to 64 KiB", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(503);
      res.write(" ".repeat(64 * 1024));
    },
    async (port) => {
      await expect(
        uploadSnapshotObjects({ ...config, endpoint: `http://127.0.0.1:${port}` }, objects, {
          allowlist: parseNetworkAllowlist(["127.0.0.1"]),
          sleep: async () => {},
        }),
      ).rejects.toThrow("HTTP 503");
    },
  );
});

test("default AWS and region-derived hosts come from the signed URL", () => {
  expect(presignSnapshotObject(config, objects[0]!.path).hostname).toBe("s3.us-east-1.amazonaws.com");
  expect(presignSnapshotObject({ ...config, region: "eu-central-1" }, objects[0]!.path).hostname).toBe("s3.eu-central-1.amazonaws.com");
});
