import { describe, expect, test } from "bun:test";
import { createCloudLinkRewriter } from "./cloud-links";

describe("streaming Cloud links", () => {
  test("rewrites links split at every delimiter and strips the base's trailing slash", () => {
    const links = createCloudLinkRewriter("https://cloud.example.org/");
    expect(links.push("[Mail]")).toBe("[Mail");
    expect(links.push("(")).toBe("");
    expect(links.push("/")).toBe("");
    expect(links.push("app/mail/x)")).toBe("](https://cloud.example.org/app/mail/x)");
    expect(links.flush()).toBe("");
  });

  test.each(["/open/mail.draft/~AbC123", "/open/demo.item/~.."])("preserves the resource id in %s", (path) => {
    const links = createCloudLinkRewriter("https://cloud.example.org");
    const rewritten = links.push(`[Resource](${path})`) + links.flush();
    expect(rewritten).toBe(`[Resource](https://cloud.example.org${path})`);
    expect(new URL(`https://cloud.example.org${path}`).pathname).toBe(path);
  });

  test("keeps protocol-relative and absolute links unchanged", () => {
    const links = createCloudLinkRewriter("https://cloud.example.org");
    expect(links.push("[A](//x/a) [B](https://other.test/b) [C](relative)")).toBe("[A](//x/a) [B](https://other.test/b) [C](relative)");
    expect(links.push("[D](")).toBe("[D");
    expect(links.push("/")).toBe("");
    expect(links.push("/x)")).toBe("](//x)");
  });

  test("keeps newlines after delimiters and rewrites several links in a delta", () => {
    const links = createCloudLinkRewriter("https://cloud.example.org");
    expect(links.push("text]\n")).toBe("text]\n");
    expect(links.flush()).toBe("");
    expect(links.push("[A](/a) [B](/b)")).toBe("[A](https://cloud.example.org/a) [B](https://cloud.example.org/b)");
  });

  test.each([
    ["]", "text"],
    ["](", "text"],
    ["](/", "text"],
  ])("flush preserves the unfinished delimiter %s", (tail, text) => {
    const links = createCloudLinkRewriter("https://cloud.example.org");
    expect(links.push(text + tail)).toBe(text);
    expect(links.flush()).toBe(tail);
    expect(links.flush()).toBe("");
  });
});
