import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import type { RequestActor } from "../server/middleware/auth";
import * as approvals from "./approvals";
import * as firecrawl from "./firecrawl-tools";
import * as provenance from "./web-provenance";
import { readWebPageForPerson, stripWebReaderImages, WebReaderResultSchema } from "./web-reader";

const actor: RequestActor = {
  kind: "user",
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    uid: "person",
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Test",
    sn: "User",
    displayName: "Test User",
    mail: null,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  },
};
const conversationId = "22222222-2222-4222-8222-222222222222";
const url = "https://example.com/article?full=address";
const at = "2026-11-14T12:00:00.000Z";
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => setSystemTime(new Date(at)));
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  setSystemTime();
});

function setup() {
  const configured = spyOn(firecrawl, "isCloudAiFirecrawlConfigured").mockResolvedValue(true);
  const hasProvenance = spyOn(provenance, "hasWebAddressProvenance").mockResolvedValue(false);
  const remembered = spyOn(approvals, "findRememberedAiToolApproval").mockResolvedValue(null);
  const record = spyOn(provenance, "recordWebAddresses").mockResolvedValue();
  const extract = spyOn(firecrawl, "runCloudAiWebExtract").mockResolvedValue({
    url,
    title: "Article",
    description: "Description",
    content: "# Article\n[Next](https://example.org/next)",
    truncated: false,
  });
  spies.push(configured, hasProvenance, remembered, record, extract);
  const lookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ];
  const read = (input: Partial<Parameters<typeof readWebPageForPerson>[0]> = {}) =>
    readWebPageForPerson({ actor, conversationId, url, ...input }, { lookup });
  return { configured, hasProvenance, remembered, record, extract, read };
}

describe("person's web reader", () => {
  test("removes inline, nested, reference and HTML images while retaining Markdown and normal links", () => {
    const content = [
      "# Heading",
      "",
      "**Text ![nested](https://image.test/a(b).png)**",
      '![inline](<https://image.test/b> "title")',
      "![reference][image] ![collapsed][] ![shortcut]",
      "[Read](https://example.org/next)",
      '<IMG src="https://image.test/c" alt="a > b">',
      "<img\nsrc='https://image.test/d' />",
      "",
      "[image]: https://image.test/ref",
      "[collapsed]: https://image.test/collapsed",
      "[shortcut]: https://image.test/shortcut",
    ].join("\n");
    const result = stripWebReaderImages(content);
    expect(result).toContain("# Heading");
    expect(result).toContain("**Text **");
    expect(result).toContain("[Read](https://example.org/next)");
    expect(result).not.toContain("![");
    expect(result.toLowerCase()).not.toContain("<img");
    expect(stripWebReaderImages('<iframe src="https://example.org"></iframe>')).not.toContain("<iframe");
    expect(stripWebReaderImages("![]![remove](https://image.test/x)(https://image.test/new)")).toBe("\\![](https://image.test/new)");
    expect(stripWebReaderImages('<i![remove](https://image.test/x)mg src="https://image.test/new">')).not.toContain("<img");
    expect(stripWebReaderImages("\\![escaped](https://example.org/a)")).toBe("\\![escaped](https://example.org/a)");
    expect(stripWebReaderImages("<https://example.org/next>")).toBe("<https://example.org/next>");
  });

  test("unknown addresses ask with the complete URL and never fetch or record", async () => {
    const { read, extract, record } = setup();
    expect(await read()).toEqual({ status: "confirm", url });
    expect(extract).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  test("confirmation fetches exactly the supplied address once, fresh, and records page links", async () => {
    const { read, extract, record } = setup();
    const result = await read({ confirmed: true });
    expect(result).toEqual({
      status: "ready",
      url,
      finalUrl: url,
      title: "Article",
      description: "Description",
      markdown: "# Article\n[Next](https://example.org/next)",
      truncated: false,
      contentAt: at,
    });
    expect(WebReaderResultSchema.parse(result)).toEqual(result);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]?.[0]).toEqual({ url });
    expect(extract.mock.calls[0]?.[1]).toMatchObject({ maxAge: 0, signal: expect.any(AbortSignal) });
    expect(record).toHaveBeenCalledWith(conversationId, new Set([url, "https://example.org/next"]));
    // This confirmation is request-local, not permission for another address on the site.
    expect(await read({ url: "https://example.com/other" })).toEqual({ status: "confirm", url: "https://example.com/other" });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  test("provenance and the person's remembered website for this chat each allow a read", async () => {
    const { read, hasProvenance, remembered, extract } = setup();
    hasProvenance.mockResolvedValue(true);
    expect((await read()).status).toBe("ready");
    expect(remembered).not.toHaveBeenCalled();
    hasProvenance.mockResolvedValue(false);
    remembered.mockResolvedValue("approval");
    expect((await read()).status).toBe("ready");
    expect(remembered).toHaveBeenCalledWith(
      { actorUserId: actor.user.id },
      {
        toolName: approvals.AI_WEBSITE_APPROVAL_TOOL,
        approvalScope: approvals.aiWebsiteApprovalScope("https://example.com"),
        conversationId,
        chatOnly: true,
      },
    );
    expect(extract).toHaveBeenCalledTimes(2);
  });

  test("rejects any unsafe A or AAAA answer before Firecrawl, including mixed answers", async () => {
    const { extract } = setup();
    for (const unsafe of [
      { address: "10.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ]) {
      let caught: unknown;
      try {
        await readWebPageForPerson(
          { actor, conversationId, url, confirmed: true },
          {
            lookup: async () => [{ address: "93.184.216.34", family: 4 }, unsafe],
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HTTPException);
      expect(caught).toMatchObject({ status: 403 });
    }
    expect(extract).not.toHaveBeenCalled();
  });

  test("blocks a different origin without returning or recording its content", async () => {
    const { read, extract, record } = setup();
    const finalUrl = "https://other.example/page";
    extract.mockResolvedValue({ url: finalUrl, content: "CONTENT MUST NOT ESCAPE", truncated: false });
    expect(await read({ confirmed: true })).toEqual({ status: "redirect_blocked", url, finalUrl });
    expect(record).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledTimes(1);
  });

  test("a confirmation covers exactly its address: another path of the site needs its own right; independently authorized redirects read", async () => {
    const { read, extract, hasProvenance, remembered } = setup();
    // The site only adds HTTPS or a trailing slash: still the confirmed address.
    extract.mockResolvedValue({ url: "https://example.com/article/?full=address", content: "Article", truncated: false });
    expect((await read({ confirmed: true })).status).toBe("ready");
    extract.mockResolvedValue({ url: "https://example.com/final?data=secret", content: "Article", truncated: false });
    expect(await read({ confirmed: true })).toMatchObject({ status: "redirect_blocked" });
    const finalUrl = "https://other.example/final";
    extract.mockResolvedValue({ url: finalUrl, content: "Article", truncated: false });
    hasProvenance.mockImplementation(async (_conversationId, address) => address === finalUrl);
    expect((await read({ confirmed: true })).status).toBe("ready");
    hasProvenance.mockResolvedValue(false);
    remembered.mockImplementation(async (_context, target) => (target.approvalScope === "https://other.example" ? "approval" : null));
    expect((await read({ confirmed: true })).status).toBe("ready");
  });

  test("checks the final URL's public syntax and every DNS answer too", async () => {
    const { extract, read, record } = setup();
    extract.mockResolvedValue({ url: "http://127.0.0.1/private", content: "Hidden", truncated: false });
    await expect(read({ confirmed: true })).rejects.toMatchObject({ status: 403 });
    extract.mockResolvedValue({ url: "https://other.example/private", content: "Hidden", truncated: false });
    await expect(
      readWebPageForPerson(
        { actor, conversationId, url, confirmed: true },
        {
          lookup: async (hostname) => [
            { address: hostname === "other.example" ? "::1" : "93.184.216.34", family: hostname === "other.example" ? 6 : 4 },
          ],
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(record).not.toHaveBeenCalled();
  });

  test("returns unavailable without fetching when Firecrawl is not configured", async () => {
    const { read, configured, extract, hasProvenance } = setup();
    configured.mockResolvedValue(false);
    expect(await read()).toEqual({ status: "unavailable" });
    expect(extract).not.toHaveBeenCalled();
    expect(hasProvenance).not.toHaveBeenCalled();
  });

  test("empty, image-only, explicit interstitials and failed extracts stay unreadable", async () => {
    const { read, extract, record } = setup();
    for (const content of ["", " \n ", "![only image](https://example.org/image)", "![ref][image]\n\n[image]: https://example.org/image"]) {
      extract.mockResolvedValue({ url, content, truncated: false });
      expect(await read({ confirmed: true })).toEqual({ status: "unreadable", url, reason: "empty" });
    }
    for (const content of ["Please enable JavaScript to continue.", "Sign in to continue."]) {
      extract.mockResolvedValue({ url, content, truncated: false });
      expect(await read({ confirmed: true })).toEqual({ status: "unreadable", url, reason: "failed" });
    }
    extract.mockRejectedValue(new Error("Firecrawl failed"));
    expect(await read({ confirmed: true })).toEqual({ status: "unreadable", url, reason: "failed" });
    expect(record).not.toHaveBeenCalled();
  });

  test("bounds the cleaned Markdown even when escaping HTML expands it, and preserves the extract truncation flag", async () => {
    const { read, extract } = setup();
    extract.mockResolvedValue({ url, content: `<b>${"x".repeat(999_990)}</b>`, truncated: false });
    const expanded = await read({ confirmed: true });
    expect(expanded.status).toBe("ready");
    if (expanded.status !== "ready") throw new Error("Expected a readable page");
    expect(expanded.markdown.length).toBe(firecrawl.WEB_EXTRACT_MAX_CONTENT_CHARS);
    expect(expanded.truncated).toBe(true);
    extract.mockResolvedValue({ url, content: "Article", truncated: true });
    expect(await read({ confirmed: true })).toMatchObject({ status: "ready", truncated: true });
  });

  test("cancellation during DNS resolution stops before Firecrawl", async () => {
    const { extract } = setup();
    const controller = new AbortController();
    const reason = new Error("Person closed the view");
    await expect(
      readWebPageForPerson(
        { actor, conversationId, url, confirmed: true, signal: controller.signal },
        {
          lookup: async () => {
            controller.abort(reason);
            return [{ address: "93.184.216.34", family: 4 }];
          },
        },
      ),
    ).rejects.toBe(reason);
    expect(extract).not.toHaveBeenCalled();
  });

  test("invalid and non-public URLs throw HTTP errors before fetching", async () => {
    const { read, extract } = setup();
    for (const url of ["invalid", "ftp://example.org/file", "https://person:secret@example.com/"])
      await expect(read({ url })).rejects.toMatchObject({ status: 400 });
    await expect(read({ url: "http://localhost/" })).rejects.toMatchObject({ status: 403 });
    expect(extract).not.toHaveBeenCalled();
  });
});
