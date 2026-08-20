import { describe, expect, test } from "bun:test";
import {
  assertPublicHttpUrl,
  createCloudAiWebExtractTool,
  createCloudAiWebSearchTool,
  runCloudAiWebExtract,
  runCloudAiWebSearch,
} from "./firecrawl-tools";

describe("Firecrawl AI tools", () => {
  test("rejects non-public URLs before extraction", () => {
    expect(() => assertPublicHttpUrl("ftp://example.com/file")).toThrow("http or https");
    expect(() => assertPublicHttpUrl("http://localhost:3000")).toThrow("not allowed");
    expect(() => assertPublicHttpUrl("http://127.0.0.1:3000")).toThrow("private IP");
    expect(() => assertPublicHttpUrl("http://10.0.0.1")).toThrow("private IP");
    expect(assertPublicHttpUrl("https://example.com/path")).toBe("https://example.com/path");
  });

  test("normalizes search results and omits scraped content", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({
        success: true,
        data: {
          web: [
            {
              title: "Example",
              description: "A compact result",
              url: "https://example.com",
              markdown: "This must not be returned by web_search.",
            },
          ],
        },
        creditsUsed: 1,
      });
    };

    const result = await runCloudAiWebSearch({ query: "example" }, { apiKey: "fc-secret", fetch: fetcher as typeof fetch });

    expect(calls[0]?.url).toBe("https://api.firecrawl.dev/v2/search");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      query: "example",
      limit: 5,
      sources: ["web"],
      timeout: 30000,
      ignoreInvalidURLs: true,
    });
    // Flat result list — billing metadata like creditsUsed never reaches the model.
    expect(result).toEqual([{ title: "Example", url: "https://example.com", snippet: "A compact result", position: 1 }]);
    expect(JSON.stringify(result)).not.toContain("fc-secret");
    expect(JSON.stringify(result)).not.toContain("must not be returned");
    expect(JSON.stringify(result)).not.toContain("creditsUsed");
  });

  test("extracts markdown main content with deterministic truncation", async () => {
    const fetcher = async () =>
      Response.json({
        success: true,
        data: {
          markdown: "0123456789abcdef",
          metadata: {
            title: "Example Page",
            description: "Useful source",
            sourceURL: "https://example.com/page",
          },
        },
        warning: "cached",
        creditsUsed: 2,
      });

    const result = await runCloudAiWebExtract(
      { url: "https://example.com/page" },
      { apiKey: "fc-secret", fetch: fetcher as unknown as typeof fetch, maxChars: 10 },
    );

    expect(result).toEqual({
      url: "https://example.com/page",
      title: "Example Page",
      description: "Useful source",
      content: "0123456789",
      truncated: true,
    });
    expect(JSON.stringify(result)).not.toContain("fc-secret");
    expect(JSON.stringify(result)).not.toContain("creditsUsed");
  });

  test("keeps large extracts up to the independent web safety limit", async () => {
    const content = "x".repeat(1_000_100);
    const fetcher = async () =>
      Response.json({
        success: true,
        data: { markdown: content, metadata: { sourceURL: "https://example.com/large" } },
      });

    const result = await runCloudAiWebExtract(
      { url: "https://example.com/large" },
      { apiKey: "fc-secret", fetch: fetcher as unknown as typeof fetch },
    );

    expect(result.content.length).toBe(1_000_000);
    expect(result.truncated).toBe(true);
  });

  test("keeps all sources in historical search results while bounding snippets", async () => {
    const tool = createCloudAiWebSearchTool({ apiKey: "fc-secret" });
    const output = Array.from({ length: 5 }, (_, index) => ({
      title: `Source ${index + 1}`,
      url: `https://example.com/${index + 1}`,
      snippet: `start-${index}-${"x".repeat(800)}-end-${index}`,
      position: index + 1,
    }));

    const historical = await tool.def.toHistoricalResult?.({ input: { query: "context retention" }, output, callId: "search-1" });
    expect(historical).toHaveLength(5);
    expect(JSON.stringify(historical)).toContain("https://example.com/5");
    expect(JSON.stringify(historical).length).toBeLessThan(JSON.stringify(output).length);
  });

  test("keeps substantial source content in historical extracts", async () => {
    const tool = createCloudAiWebExtractTool({ apiKey: "fc-secret" });
    const content = `opening evidence\n${"detail ".repeat(1_200)}\nclosing evidence`;
    const historical = await tool.def.toHistoricalResult?.({
      input: { url: "https://example.com/report" },
      output: {
        url: "https://example.com/report",
        title: "Report",
        description: "Primary source",
        content,
        truncated: false,
      },
      callId: "extract-1",
    });

    expect(historical).toMatchObject({
      url: "https://example.com/report",
      title: "Report",
      description: "Primary source",
      truncated: true,
    });
    expect(JSON.stringify(historical)).toContain("opening evidence");
    expect(JSON.stringify(historical)).toContain("closing evidence");
    expect((historical as { content: string }).content.length).toBeGreaterThanOrEqual(4_000);
  });
});
