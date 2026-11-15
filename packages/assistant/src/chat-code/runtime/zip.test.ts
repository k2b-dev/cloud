import { expect, test } from "bun:test";
import { createZip } from "@k2b/stdlib/browser";
import { LIMITS } from "../contracts";
import { createZipFile, openZip, ZIP_LIMITS } from "./zip";

const archive = async (name = "report.xml", text = "<Document>bank report</Document>") =>
  new Uint8Array(await createZip([{ filename: name, source: text }]));
const blob = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)]);
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const central = (bytes: Uint8Array) => view(bytes).getUint32(bytes.length - 6, true);

test("ZIP budgets reuse file, runtime data and path ceilings", () => {
  expect(ZIP_LIMITS.fileBytes).toBe(LIMITS.inputFileBytes);
  expect(ZIP_LIMITS.expandedBytes).toBe(LIMITS.rpcBytes);
  expect(ZIP_LIMITS.entries).toBe(LIMITS.files);
  expect(ZIP_LIMITS.ratio).toBe(64);
});
test("lists, reads bytes and UTF-8 text, and returns a downloadable File", async () => {
  const file = await createZipFile([{ name: "bank/report.xml", data: "<Document>Überweisung</Document>" }], "bank.zip");
  expect(file.name).toBe("bank.zip");
  expect(file.type).toBe("application/zip");
  const zip = await openZip(file);
  expect(zip.entries[0]).toMatchObject({ name: "bank/report.xml", directory: false });
  expect(await zip.text("bank/report.xml")).toBe("<Document>Überweisung</Document>");
  expect(new TextDecoder().decode(await zip.read("bank/report.xml"))).toBe("<Document>Überweisung</Document>");
  await expect(zip.read("missing")).rejects.toMatchObject({ code: "not_found" });
});
test("reads deflated data incrementally", async () => {
  const text = "<Report>entry amount=12.34</Report>".repeat(20);
  const zip = await openZip(blob(await archive("report.xml", text)));
  expect(await zip.text("report.xml")).toBe(text);
});
test("refuses declared and actual expansion bombs", async () => {
  await expect(openZip(blob(await archive("bomb.txt", "x".repeat(100_000))))).rejects.toMatchObject({
    code: "limit",
    message: expect.stringContaining("ratio"),
  });
  const bytes = await archive("false.txt", "x".repeat(100_000));
  view(bytes).setUint32(central(bytes) + 24, 1, true);
  const zip = await openZip(blob(bytes));
  await expect(zip.read("false.txt")).rejects.toMatchObject({ code: "limit", message: expect.stringContaining("declared size") });
});
test("checks the expanded total before extraction", async () => {
  const bytes = await archive();
  view(bytes).setUint32(central(bytes) + 24, ZIP_LIMITS.expandedBytes + 1, true);
  await expect(openZip(blob(bytes))).rejects.toMatchObject({ code: "limit", message: expect.stringContaining("expanded size") });
  await expect(
    createZipFile([{ name: "large.txt", data: new Blob([new Uint8Array(ZIP_LIMITS.expandedBytes + 1)]) }]),
  ).rejects.toMatchObject({ code: "limit" });
});
test("checks archive input size before reading bytes", async () => {
  const file = new Blob(["unread"]);
  Object.defineProperty(file, "size", { value: ZIP_LIMITS.fileBytes + 1 });
  await expect(openZip(file)).rejects.toMatchObject({ code: "limit", message: expect.stringContaining("file limit") });
});
test("counts all entries, including empty files and directories", async () => {
  const bytes = await createZip(Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => ({ filename: `${i}/`, source: "" })));
  await expect(openZip(blob(bytes))).rejects.toMatchObject({ code: "limit", message: expect.stringContaining("entry limit") });
  await expect(
    createZipFile(Array.from({ length: ZIP_LIMITS.entries + 1 }, (_, i) => ({ name: `${i}.txt`, data: "" }))),
  ).rejects.toMatchObject({ code: "limit" });
  expect(
    (await openZip(blob(await createZip(Array.from({ length: ZIP_LIMITS.entries }, (_, i) => ({ filename: `${i}.txt`, source: "" }))))))
      .entries,
  ).toHaveLength(ZIP_LIMITS.entries);
});
for (const name of ["../bad.xml", "/root.xml", "C:/a.xml", "a\\b.xml", "a/../b.xml", "./bad.xml", "bad\0.xml"]) {
  test(`rejects unsafe ZIP path ${JSON.stringify(name)} on creation and reading`, async () => {
    await expect(createZipFile([{ name, data: "unsafe" }])).rejects.toMatchObject({ code: "invalid" });
    const bytes = await archive("x".repeat(name.length));
    const encoded = new TextEncoder().encode(name);
    bytes.set(encoded, 30);
    bytes.set(encoded, central(bytes) + 46);
    await expect(openZip(blob(bytes))).rejects.toMatchObject({ code: "invalid" });
  });
}
test("rejects encryption in central or local headers and AES method", async () => {
  for (const location of ["central", "local", "aes"]) {
    const bytes = await archive();
    if (location === "central") view(bytes).setUint16(central(bytes) + 8, 0x801, true);
    if (location === "local") view(bytes).setUint16(6, 0x801, true);
    if (location === "aes") view(bytes).setUint16(central(bytes) + 10, 99, true);
    await expect(openZip(blob(bytes))).rejects.toMatchObject({ code: "invalid" });
  }
});
test("rejects malformed directories, mismatched local paths, duplicate names, symlinks and truncated data", async () => {
  const base = await archive();
  await expect(openZip(blob(base.subarray(0, base.length - 1)))).rejects.toMatchObject({ code: "invalid" });
  const mismatch = base.slice();
  mismatch[30] = 90;
  await expect(openZip(blob(mismatch))).rejects.toMatchObject({ code: "invalid" });
  const symlink = base.slice();
  view(symlink).setUint32(central(symlink) + 38, 0xa0000000, true);
  await expect(openZip(blob(symlink))).rejects.toMatchObject({ code: "invalid" });
  const duplicate = await createZip([
    { filename: "same", source: "a" },
    { filename: "same", source: "b" },
  ]);
  await expect(openZip(blob(duplicate))).rejects.toMatchObject({ code: "invalid" });
});

test("a multi-chunk bomb with forged metadata stops at the actual output limit", async () => {
  const bytes = await archive("false.txt", "x".repeat(8 * 1024 * 1024));
  view(bytes).setUint32(central(bytes) + 24, 1024, true);
  const zip = await openZip(blob(bytes));
  await expect(zip.read("false.txt")).rejects.toMatchObject({ code: "limit" });
});
test("invalid filename encodings give a recoverable ZIP error", async () => {
  const bytes = await archive("x.xml");
  bytes[30] = 0x81;
  bytes[central(bytes) + 46] = 0x81;
  await expect(openZip(blob(bytes))).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("UTF-8 filenames") });
});
