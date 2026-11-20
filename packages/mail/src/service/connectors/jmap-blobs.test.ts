import { afterEach, expect, test } from "bun:test";
import type { Readable } from "node:stream";
import { downloadJmapEmailSource, readJmapEmailBlobs } from "./jmap";
import { fetchJmapSession, jmapDownloadUrl } from "./jmap-client";
import { createJmapFixture, fixtureEmail } from "./jmap-fixture";
import { MAX_IMAP_LITERAL_BYTES } from "./source-limits";

const fixtures: ReturnType<typeof createJmapFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
const signal = () => new AbortController().signal;
async function setup() {
  const fixture = createJmapFixture();
  fixtures.push(fixture);
  const session = await fetchJmapSession(
    { origin: fixture.origin, authorization: "Basic fixture", signal: signal() },
    fixture.dependencies,
  );
  return { fixture, session };
}
const read = async (source: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

test("fills relative and absolute templates with fixed names and encoded parameters", async () => {
  const { session } = await setup();
  for (const downloadUrl of [session.downloadUrl, "/jmap/download/{accountId}/{blobId}/{name}?accept={type}"]) {
    const url = jmapDownloadUrl({ ...session, downloadUrl }, "account /?", "blob #&");
    expect(url.href).toBe("https://mail.example.invalid/jmap/download/account%20%2F%3F/blob%20%23%26/message.eml?accept=message%2Frfc822");
  }
});

test("rejects missing, unknown and malformed template variables and foreign origins", async () => {
  const { session } = await setup();
  for (const name of ["accountId", "blobId", "name", "type"]) {
    expect(() => jmapDownloadUrl({ ...session, downloadUrl: session.downloadUrl.replace(`{${name}}`, "fixed") }, "a", "b")).toThrow(
      "JMAP_DOWNLOAD_TEMPLATE",
    );
  }
  for (const suffix of ["/{unknown}", "/{+blobId}", "/{", "/}", "/{{blobId}}", "/%7B+blobId%7D"])
    expect(() => jmapDownloadUrl({ ...session, downloadUrl: session.downloadUrl + suffix }, "a", "b")).toThrow("JMAP_DOWNLOAD_TEMPLATE");
  for (const origin of ["https://foreign.example.invalid", "http://mail.example.invalid", "https://user:pass@mail.example.invalid"])
    expect(() => jmapDownloadUrl({ ...session, downloadUrl: session.downloadUrl.replace(session.origin, origin) }, "a", "b")).toThrow(
      "JMAP_ORIGIN",
    );
});

test("reads source metadata in bounded batches, including notFound and no body properties", async () => {
  const { fixture, session } = await setup();
  fixture.emails.push(fixtureEmail("one"), fixtureEmail("two"), fixtureEmail("three"));
  const result = await readJmapEmailBlobs(
    session,
    "Basic fixture",
    "d333333",
    ["one", "two", "three", "missing"],
    signal(),
    fixture.dependencies,
  );
  expect(result).toEqual({ objects: fixture.emails.map(({ id, blobId, size }) => ({ id, blobId, size })), notFoundIds: ["missing"] });
  const calls = fixture.requests.flatMap((entry) => entry.calls ?? []);
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call[0]).toBe("Email/get");
    expect(call[1].properties).toEqual(["id", "blobId", "size"]);
    expect(call[1].bodyProperties).toBeUndefined();
  }
});

test("rejects extra, missing, repeated, conflicting ids and invalid metadata", async () => {
  const { fixture, session } = await setup();
  fixture.emails.push(fixtureEmail("one"));
  for (const patch of [
    { list: [] },
    { list: [fixtureEmail("extra")] },
    { list: [fixtureEmail("one"), fixtureEmail("one")] },
    { notFound: ["one"] },
    { accountId: "other" },
    { state: null },
    { list: [{ id: "one", blobId: "invalid/id", size: 5 }] },
    { list: [{ id: "one", blobId: "valid", size: -1 }] },
  ]) {
    fixture.controls.transform = ([name, args, id]) => [name, { ...args, ...patch }, id];
    await expect(readJmapEmailBlobs(session, "Basic fixture", "d333333", ["one"], signal(), fixture.dependencies)).rejects.toMatchObject({
      code: "JMAP_INVALID_RESPONSE",
    });
  }
});

test("checks input ids, account, capabilities and cancellation before network access", async () => {
  const { fixture, session } = await setup();
  const count = fixture.requests.length;
  for (const ids of [["one", "one"], ["bad/id"], ["x".repeat(256)]])
    await expect(readJmapEmailBlobs(session, "Basic fixture", "d333333", ids, signal(), fixture.dependencies)).rejects.toMatchObject({
      code: "JMAP_INVALID_ID",
    });
  await expect(readJmapEmailBlobs(session, "Basic fixture", "missing", [], signal(), fixture.dependencies)).rejects.toMatchObject({
    code: "JMAP_ACCOUNT",
  });
  await expect(
    readJmapEmailBlobs({ ...session, capabilities: {} }, "Basic fixture", "d333333", [], signal(), fixture.dependencies),
  ).rejects.toMatchObject({ code: "JMAP_CAPABILITY" });
  const controller = new AbortController();
  controller.abort();
  await expect(readJmapEmailBlobs(session, "Basic fixture", "d333333", [], controller.signal, fixture.dependencies)).rejects.toMatchObject({
    code: "JMAP_ABORTED",
  });
  expect(fixture.requests).toHaveLength(count);
});

test("downloads exact binary bytes and rejects advertised oversize and invalid ids before requesting", async () => {
  const { fixture, session } = await setup();
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  fixture.blobs.set("blob-one", [bytes.subarray(0, 80), bytes.subarray(80)]);
  expect(
    await downloadJmapEmailSource(session, "Basic fixture", "d333333", "blob-one", bytes.length, read, signal(), fixture.dependencies),
  ).toEqual(bytes);
  const count = fixture.requests.length;
  await expect(
    downloadJmapEmailSource(
      session,
      "Basic fixture",
      "d333333",
      "blob-one",
      MAX_IMAP_LITERAL_BYTES + 1,
      read,
      signal(),
      fixture.dependencies,
    ),
  ).rejects.toMatchObject({ code: "JMAP_TOO_LARGE" });
  await expect(
    downloadJmapEmailSource(session, "Basic fixture", "d333333", "bad/id", 1, read, signal(), fixture.dependencies),
  ).rejects.toMatchObject({ code: "JMAP_INVALID_ID" });
  expect(fixture.requests).toHaveLength(count);
});

test("halves metadata batches on budget overflow and fails an oversized singleton", async () => {
  const { fixture, session } = await setup();
  fixture.emails.push(fixtureEmail("one"), fixtureEmail("two"));
  fixture.controls.transform = ([name, args, id]) => [
    name,
    {
      ...args,
      padding: Array.isArray(args.list) && args.list.length > 1 ? "x".repeat(256 * 1024) : "",
    },
    id,
  ];
  const result = await readJmapEmailBlobs(session, "Basic fixture", "d333333", ["one", "two"], signal(), fixture.dependencies);
  expect(result.objects.map((entry) => entry.id)).toEqual(["one", "two"]);
  expect(fixture.requests.flatMap((entry) => entry.calls ?? [])).toHaveLength(3);
  fixture.controls.transform = ([name, args, id]) => [name, { ...args, padding: "x".repeat(256 * 1024) }, id];
  await expect(readJmapEmailBlobs(session, "Basic fixture", "d333333", ["one"], signal(), fixture.dependencies)).rejects.toMatchObject({
    code: "JMAP_EMAIL_TOO_LARGE",
  });
});
