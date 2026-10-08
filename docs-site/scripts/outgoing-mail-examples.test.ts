import { describe, expect, test } from "bun:test";

const page = await Bun.file(new URL("../docs/en/platform/outgoing-mail.md", import.meta.url)).text();
const fixture = await Bun.file(new URL("../examples/cloud-docs/platform-outgoing-mail.ts", import.meta.url)).text();
const snippets = [...page.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? "");
const normalize = (source: string) =>
  source
    .replace(/^import .*;\n/gm, "")
    .replace(/\s+/g, " ")
    .trim();

describe("outgoing mail worked examples", () => {
  // typecheck:examples compiles the fixture, so each worked snippet compiles against the public exports.
  test("every worked snippet is included in the compile-checked fixture", () => {
    const worked = snippets.filter((snippet) => /export const (sendInvoiceMail|sendDownloadLink|enqueueStockRun) =/.test(snippet));
    expect(worked).toHaveLength(3);
    for (const snippet of worked) expect(normalize(fixture)).toContain(normalize(snippet));
  });
});
