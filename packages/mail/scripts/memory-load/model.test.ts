import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";
import { fixtures, MiB, parseArgs, sourceChunks, sourceSize, sourceStream } from "./model";

test("argument defaults, profiles and path overrides", () => {
  expect(parseArgs([])).toMatchObject({ profile: "incident", seed: 1549, mailboxes: 4, folders: 40, largePerMailbox: 3, timeoutS: 900 });
  expect(parseArgs(["--profile", "guard"])).toMatchObject({ mailboxes: 4, folders: 2, largePerMailbox: 1, largeMaxMib: 24 });
  expect(parseArgs(["--html-mib", "1.5", "--csv-mib", "4", "--only", "hydration,api", "--folders", "0", "--json"])).toMatchObject({
    htmlMib: 1.5,
    csvMib: 4,
    only: ["hydration", "api"],
    folders: 0,
    json: true,
  });
  expect(parseArgs(["--help"]).help).toBe(true);
});

test("rejects unknown, missing, repeated and invalid arguments", () => {
  for (const args of [
    ["--typo"],
    ["--seed"],
    ["--profile", "other"],
    ["--only", "api,api"],
    ["--only", "other"],
    ["--readers", "0"],
    ["--timeout-s", "NaN"],
    ["--folders", "1.5"],
    ["--seed", "-1"],
    ["--seed", "1", "--seed", "2"],
    ["--large-min-mib", "41"],
  ])
    expect(() => parseArgs(args)).toThrow();
});

test("profile sizes, attachment composition and exact descriptor sizing", () => {
  for (const profile of ["incident", "guard"]) {
    const o = parseArgs(["--profile", profile]);
    const plan = fixtures(o);
    expect(new Set(plan.map((f) => f.id)).size).toBe(plan.length);
    expect(plan).toEqual(fixtures(o));
    expect(plan.some((f) => f.large && Math.abs(f.size - 34 * MiB) < 8)).toBe(profile === "incident");
    for (const f of plan) {
      expect(sourceSize(f)).toBe(f.size);
      expect(f.size).toBeGreaterThanOrEqual((f.large ? o.largeMinMib * MiB : o.smallMinKib * 1024) - 8);
      expect(f.size).toBeLessThanOrEqual(f.large ? o.largeMaxMib * MiB : o.smallMaxKib * 1024);
      if (f.large) {
        expect(f.htmlBytes).toBeGreaterThanOrEqual(MiB);
        expect(f.htmlBytes).toBeLessThanOrEqual(6 * MiB);
        const images = f.parts.filter((p) => p.kind === "image");
        expect(images.length).toBeGreaterThanOrEqual(2);
        expect(images.length).toBeLessThanOrEqual(4);
        for (const image of images) {
          expect(image.bytes).toBeGreaterThanOrEqual(MiB / 2);
          expect(image.bytes).toBeLessThanOrEqual(2 * MiB);
        }
        const csv = f.parts.find((p) => p.kind === "csv")!;
        expect(csv.bytes).toBeGreaterThanOrEqual(4 * MiB);
        expect(csv.bytes).toBeLessThanOrEqual(18 * MiB);
      }
    }
  }
});

test("same seed streams byte-identical MIME in bounded 64 KiB chunks; different seed changes bytes", () => {
  const options = parseArgs(["--profile", "guard", "--mailboxes", "1", "--folders", "0", "--small-per-mailbox", "0"]);
  const digest = (seed: number) => {
    const f = fixtures({ ...options, seed })[0]!;
    const hash = createHash("sha256");
    let bytes = 0;
    for (const chunk of sourceChunks(f)) {
      expect(chunk.length).toBeLessThanOrEqual(65536);
      hash.update(chunk);
      bytes += chunk.length;
    }
    expect(bytes).toBe(f.size);
    return hash.digest("hex");
  };
  expect(digest(1549)).toBe(digest(1549));
  expect(digest(1550)).not.toBe(digest(1549));
});

test("mailparser reads generated MIME into expected decoded parts", async () => {
  const f = fixtures(parseArgs(["--profile", "guard", "--mailboxes", "1", "--folders", "0", "--small-per-mailbox", "0"]))[0]!;
  const parsed = await simpleParser(sourceStream(f), { skipImageLinks: true, skipHtmlToText: true, skipTextToHtml: true });
  expect(parsed.messageId).toBe(`<${f.id}@memory.test>`);
  expect(parsed.date?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  expect(Buffer.byteLength(parsed.html || "")).toBe(f.htmlBytes);
  expect(parsed.text).toContain("Newsletter");
  expect(parsed.attachments.length).toBe(f.parts.filter((p) => p.filename).length);
  for (const part of f.parts.filter((p) => p.filename)) {
    const attachment = parsed.attachments.find((a) => a.filename === part.filename)!;
    expect(attachment).toBeDefined();
    expect(attachment.content.length).toBe(part.bytes);
    if (part.cid) expect(attachment.contentId).toBe(`<${part.cid}>`);
    if (part.kind === "csv") expect(attachment.contentType).toBe("text/csv");
  }
}, 20_000);

test("small sources are valid MIME and exact-sized too; impossible part budgets fail", async () => {
  const options = parseArgs(["--mailboxes", "1", "--folders", "0", "--large-per-mailbox", "0", "--small-per-mailbox", "1"]);
  const f = fixtures(options)[0]!;
  const bytes = Buffer.concat([...sourceChunks(f)]);
  expect(bytes.length).toBe(f.size);
  const parsed = await simpleParser(bytes, { skipImageLinks: true });
  expect(parsed.attachments.length).toBe(2);
  expect(() => fixtures({ ...options, largePerMailbox: 1, htmlMib: 40 })).toThrow("Components exceed");
});

test("stream generation honors cancellation", async () => {
  const f = fixtures(parseArgs(["--profile", "guard", "--mailboxes", "1", "--folders", "0"]))[0]!;
  const abort = new AbortController();
  const chunks = sourceChunks(f, abort.signal);
  expect(chunks.next().value?.length).toBe(65536);
  abort.abort(new Error("fixture cancelled"));
  expect(() => chunks.next()).toThrow("fixture cancelled");
});

test("the small CSV warms the real document extractor without infrastructure", async () => {
  const { extractDocumentMarkdown } = await import("../../../cloud/src/services/document-extraction");
  const f = fixtures(parseArgs(["--mailboxes", "1", "--folders", "0", "--large-per-mailbox", "0", "--small-per-mailbox", "1"]))[0]!;
  const parsed = await simpleParser(sourceStream(f), { skipImageLinks: true });
  const csv = parsed.attachments.find((a) => a.contentType === "text/csv")!;
  const extracted = await extractDocumentMarkdown({ bytes: csv.content, filename: csv.filename });
  expect(extracted.format).toBe("csv");
  expect(extracted.markdown).toContain("Newsletter subscription");
}, 20_000);
