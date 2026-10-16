import { expect, mock, test } from "bun:test";
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
type Failure = { stall?: boolean; error?: boolean | Error; aborted?: boolean; noResponse?: boolean };
const fixture = (status: number | Array<number | Failure> = 200, chunks = [""], options: Failure = {}) => {
  const sent: RequestOptions[] = [];
  const bodies: Buffer[] = [];
  let timeout: (() => void) | undefined;
  let destroyed = 0;
  const request = (opts: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
    const outcome = Array.isArray(status) ? status[Math.min(sent.length, status.length - 1)]! : status;
    const behavior = typeof outcome === "number" ? options : outcome;
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
        if (behavior.error) {
          outgoing.emit("error", behavior.error instanceof Error ? behavior.error : new Error("SECRET"));
          return;
        }
        if (behavior.noResponse) return;
        const response = new IncomingMessage(new Socket());
        response.statusCode = typeof outcome === "number" ? outcome : 500;
        callback(response);
        for (const chunk of chunks) response.push(Buffer.from(chunk));
        if (behavior.aborted) response.emit("aborted");
        else if (!behavior.stall) response.push(null);
      });
      return outgoing;
    }) as ClientRequest["end"];
    return outgoing;
  };
  return { request, sent, bodies, sleep: mock(async (_ms: number) => {}), expire: () => timeout?.(), destroyed: () => destroyed };
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

for (const status of [307, 403]) {
  test(`HTTP ${status} fails after one request`, async () => {
    const f = fixture(status);
    await expect(uploadSnapshotObjects(config, objects, { ...f, allowlist, lookup })).rejects.toThrow(`HTTP ${status}`);
    expect(f.sent).toHaveLength(1);
    expect(f.sleep).not.toHaveBeenCalled();
  });
  test(`HTTP ${status} with an aborted error body is not retried`, async () => {
    const f = fixture(status, [], { aborted: true });
    await expect(uploadSnapshotObjects(config, objects, { ...f, allowlist, lookup })).rejects.toThrow("S3 response connection failed");
    expect(f.sent).toHaveLength(1);
    expect(f.sleep).not.toHaveBeenCalled();
  });
}

test("a transport guard refusal is never retried", async () => {
  const blocked = new NetworkTargetBlockedError("Network target host is not allowed");
  const f = fixture([{ error: blocked }]);
  await expect(uploadSnapshotObjects(config, objects, { ...f, allowlist, lookup })).rejects.toBe(blocked);
  expect(f.sent).toHaveLength(1);
  expect(f.sleep).not.toHaveBeenCalled();
});

for (const outcome of [503, 500, 599, 429, 408, { error: true }, { aborted: true }]) {
  test(`transient ${JSON.stringify(outcome)} retries once then succeeds`, async () => {
    const f = fixture([outcome, 200]);
    expect(await uploadSnapshotObjects(config, objects, { ...f, allowlist, lookup })).toEqual([{ path: objects[0]!.path, bytes: 3 }]);
    expect(f.sent).toHaveLength(2);
    expect(f.sleep.mock.calls).toEqual([[200]]);
  });
}

test("four 503s exhaust the per-object retry budget with exponential backoff", async () => {
  const f = fixture([503, 503, 503, 503]);
  await expect(uploadSnapshotObjects(config, objects, { ...f, allowlist, lookup })).rejects.toThrow(
    `Failed to upload ${objects[0]!.path}. HTTP 503`,
  );
  expect(f.sent).toHaveLength(4);
  expect(f.sleep.mock.calls).toEqual([[200], [400], [800]]);
});

test("the final error uses the last attempt's reason", async () => {
  const f = fixture([503, 503, 503, 429]);
  await expect(uploadSnapshotObjects(config, objects, { ...f, allowlist, lookup })).rejects.toThrow(
    `Failed to upload ${objects[0]!.path}. HTTP 429`,
  );
  expect(f.sent).toHaveLength(4);
});

test("S3 error messages are readable and bounded", async () => {
  const f = fixture(403, ["<Error><Code>AccessDenied</Code><Message>Check bucket &amp; key.</Message></Error>"]);
  await expect(uploadSnapshotObjects(config, objects, { ...f, allowlist, lookup })).rejects.toThrow("AccessDenied: Check bucket & key.");
  const padded = fixture(403, ["<Error><Code>\n  AccessDenied \n</Code><Message>  Denied.  </Message></Error>"]);
  await expect(uploadSnapshotObjects(config, objects, { ...padded, allowlist, lookup })).rejects.toThrow("HTTP 403: AccessDenied: Denied.");
  // Unclosed fields padded with whitespace must parse in linear time (a backtracking pattern takes minutes here).
  const unclosed = fixture(503, [`<Error><Code>${" ".repeat(30 * 1024)}<Message>${" ".repeat(30 * 1024)}`]);
  await expect(uploadSnapshotObjects(config, objects, { ...unclosed, allowlist, lookup })).rejects.toThrow(/^Failed to upload .*HTTP 503$/);
  const large = fixture(503, [" ".repeat(64 * 1024)], { stall: true });
  await expect(uploadSnapshotObjects(config, objects, { ...large, allowlist, lookup })).rejects.toThrow("HTTP 503");
  expect(large.destroyed()).toBe(4);
});

test("a 2xx answer settles at its headers even when the endpoint keeps sending", async () => {
  expect(await uploadSnapshotObjects(config, objects, { ...fixture(200, ["x"], { stall: true }), allowlist, lookup })).toEqual([
    { path: objects[0]!.path, bytes: 3 },
  ]);
});

test("idle timeout destroys a stalled upload; failures do not expose transport errors", async () => {
  const f = fixture(200, [], { noResponse: true });
  const promise = uploadSnapshotObjects(config, objects, { ...f, allowlist, lookup });
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.expire();
  }
  await expect(promise).rejects.toThrow("S3 upload connection failed or timed out");
  expect(f.sent).toHaveLength(4);
  expect(f.destroyed()).toBe(4);
  for (const options of [{ error: true }, { aborted: true }]) {
    await expect(uploadSnapshotObjects(config, objects, { ...fixture(500, [], options), allowlist, lookup })).rejects.toThrow(
      /S3 .*connection failed/,
    );
  }
});

test("signs each object right before its request so long uploads never send an expired signature", async () => {
  const f = fixture([503, 200, 503, 200]);
  const events: string[] = [];
  const resolveTarget = mock(lookup);
  const many = [objects[0]!, { ...objects[0]!, path: "notebooks/nb1234/latest-manifest.json" }];
  await uploadSnapshotObjects(config, many, {
    allowlist,
    lookup: resolveTarget,
    sleep: f.sleep,
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
    "sign notebooks/nb1234/latest.zip",
    "send /bucket/notebooks/nb1234/latest.zip",
    "sign notebooks/nb1234/latest-manifest.json",
    "send /bucket/notebooks/nb1234/latest-manifest.json",
    "sign notebooks/nb1234/latest-manifest.json",
    "send /bucket/notebooks/nb1234/latest-manifest.json",
  ]);
  expect(resolveTarget).toHaveBeenCalledTimes(1);
  expect(f.sent).toHaveLength(4);
  expect(f.sleep.mock.calls).toEqual([[200], [200]]);
  for (const sent of f.sent) {
    if (!sent.lookup) throw new Error("Missing pinned lookup");
    sent.lookup("snapshots.test", { family: 4, all: false }, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe("127.0.0.1");
      expect(family).toBe(4);
    });
  }
});

test("a changed target stops before the retry request", async () => {
  const f = fixture(503);
  let signatures = 0;
  await expect(
    uploadSnapshotObjects(config, objects, {
      ...f,
      allowlist,
      lookup,
      presign: (signing, path) => {
        const url = presignSnapshotObject(signing, path);
        if (++signatures === 3) url.hostname = "other.test";
        return url;
      },
    }),
  ).rejects.toThrow("S3 upload target changed between objects");
  expect(signatures).toBe(3);
  expect(f.sent).toHaveLength(1);
  expect(f.sleep.mock.calls).toEqual([[200]]);
});
