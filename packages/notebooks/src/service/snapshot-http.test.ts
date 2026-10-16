import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type ClientRequest, IncomingMessage, type RequestOptions } from "node:http";
import { Socket } from "node:net";
import { NetworkTargetBlockedError } from "@k2b/cloud/services/network-security";
import { parseNetworkAllowlist } from "@k2b/cloud/shared";
import { presignSnapshotObject, uploadSnapshotObjects } from "./snapshot-http";

const config = {
  bucket: "bucket",
  endpoint: "http://snapshots.test:9000",
  region: "us-east-1",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
};
const objects = [{ path: "notebooks/nb1234/latest.zip", contentType: "application/zip", content: new Uint8Array([1, 2, 255]) }];
const fixture = (
  status = 200,
  chunks = [""],
  options: { stall?: boolean; error?: boolean; aborted?: boolean; noResponse?: boolean } = {},
) => {
  const sent: RequestOptions[] = [];
  const bodies: Buffer[] = [];
  let timeout: (() => void) | undefined;
  let destroyed = 0;
  const request = (opts: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
    sent.push(opts);
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.destroy = (() => {
      destroyed++;
      outgoing.emit("error", new Error("SECRET"));
      return outgoing;
    }) as ClientRequest["destroy"];
    outgoing.setTimeout = ((_ms: number, onTimeout: () => void) => {
      timeout = onTimeout;
      return outgoing;
    }) as ClientRequest["setTimeout"];
    outgoing.end = ((body: Buffer) => {
      bodies.push(body);
      queueMicrotask(() => {
        if (options.error) {
          outgoing.emit("error", new Error("SECRET"));
          return;
        }
        if (options.noResponse) return;
        const response = new IncomingMessage(new Socket());
        response.statusCode = status;
        callback(response);
        for (const chunk of chunks) response.push(Buffer.from(chunk));
        if (options.aborted) response.emit("aborted");
        else if (!options.stall) response.push(null);
      });
      return outgoing;
    }) as ClientRequest["end"];
    return outgoing;
  };
  return { request, sent, bodies, expire: () => timeout?.(), destroyed: () => destroyed };
};
const allowlist = parseNetworkAllowlist(["snapshots.test"]);
const lookup = async () => [{ address: "127.0.0.1", family: 4 }];

test("guard refusals and failed or empty lookups never call the transport", async () => {
  const f = fixture();
  await expect(uploadSnapshotObjects(config, objects, { ...f, lookup })).rejects.toBeInstanceOf(NetworkTargetBlockedError);
  for (const endpoint of ["http://127.0.0.1:9000", "http://[::ffff:127.0.0.1]:9000"]) {
    await expect(uploadSnapshotObjects({ ...config, endpoint }, objects, f)).rejects.toBeInstanceOf(NetworkTargetBlockedError);
  }
  for (const lookup of [
    async () => [],
    async () => {
      throw new Error("Lookup failed");
    },
  ]) {
    await expect(uploadSnapshotObjects(config, objects, { ...f, allowlist, lookup })).rejects.toThrow();
  }
  expect(f.sent).toHaveLength(0);
});

test("signed PUT keeps Host, SNI, content headers and a lookup containing only checked addresses", async () => {
  const f = fixture();
  expect(await uploadSnapshotObjects({ ...config, endpoint: "https://snapshots.test:9000" }, objects, { ...f, allowlist, lookup })).toEqual(
    [{ path: objects[0]!.path, bytes: 3 }],
  );
  const sent = f.sent[0]!;
  expect(sent).toMatchObject({
    hostname: "snapshots.test",
    port: "9000",
    method: "PUT",
    servername: "snapshots.test",
    agent: false,
    headers: { host: "snapshots.test:9000", "content-type": "application/zip", "content-length": "3" },
  });
  const url = new URL(String(sent.path), "https://snapshots.test:9000");
  expect(url.pathname).toBe("/bucket/notebooks/nb1234/latest.zip");
  expect(url.searchParams.has("X-Amz-Signature")).toBe(true);
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  expect(url.searchParams.has("response-content-type")).toBe(false);
  expect(f.bodies).toEqual([Buffer.from([1, 2, 255])]);
  const resolve = sent.lookup;
  if (!resolve) throw new Error("Missing pinned lookup");
  resolve("snapshots.test", { family: 4, all: false }, (error, address, family) => {
    expect(error).toBeNull();
    expect(address).toBe("127.0.0.1");
    expect(family).toBe(4);
  });
});

test("redirects fail after one request", async () => {
  const f = fixture(307);
  await expect(uploadSnapshotObjects(config, objects, { ...f, allowlist, lookup })).rejects.toThrow("HTTP 307");
  expect(f.sent).toHaveLength(1);
});

test("S3 error messages are readable and bounded", async () => {
  const f = fixture(403, ["<Error><Code>AccessDenied</Code><Message>Check bucket &amp; key.</Message></Error>"]);
  await expect(uploadSnapshotObjects(config, objects, { ...f, allowlist, lookup })).rejects.toThrow("AccessDenied: Check bucket & key.");
  const large = fixture(503, [" ".repeat(64 * 1024)], { stall: true });
  await expect(uploadSnapshotObjects(config, objects, { ...large, allowlist, lookup })).rejects.toThrow("HTTP 503");
  expect(large.destroyed()).toBe(1);
});

test("a 2xx answer settles at its headers even when the endpoint keeps sending", async () => {
  expect(await uploadSnapshotObjects(config, objects, { ...fixture(200, ["x"], { stall: true }), allowlist, lookup })).toEqual([
    { path: objects[0]!.path, bytes: 3 },
  ]);
});

test("idle timeout destroys a stalled upload; failures do not expose transport errors", async () => {
  const f = fixture(200, [], { noResponse: true });
  const promise = uploadSnapshotObjects(config, objects, { ...f, allowlist, lookup });
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.expire();
  await expect(promise).rejects.toThrow("S3 upload connection failed or timed out");
  expect(f.destroyed()).toBe(1);
  for (const options of [{ error: true }, { aborted: true }]) {
    await expect(uploadSnapshotObjects(config, objects, { ...fixture(500, [], options), allowlist, lookup })).rejects.toThrow(
      /S3 .*connection failed/,
    );
  }
});

test("signs each object right before its request so long uploads never send an expired signature", async () => {
  const f = fixture();
  const events: string[] = [];
  const many = [objects[0]!, { ...objects[0]!, path: "notebooks/nb1234/latest-manifest.json" }];
  await uploadSnapshotObjects(config, many, {
    allowlist,
    lookup,
    presign: (signing, path) => {
      events.push(`sign ${path}`);
      return presignSnapshotObject(signing, path);
    },
    request: (options, callback) => {
      events.push(`send ${new URL(String(options.path), "http://snapshots.test").pathname}`);
      return f.request(options, callback);
    },
  });
  expect(events).toEqual([
    "sign notebooks/nb1234/latest.zip",
    "sign notebooks/nb1234/latest.zip",
    "send /bucket/notebooks/nb1234/latest.zip",
    "sign notebooks/nb1234/latest-manifest.json",
    "send /bucket/notebooks/nb1234/latest-manifest.json",
  ]);
});
