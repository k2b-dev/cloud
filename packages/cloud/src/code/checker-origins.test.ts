import { expect, test } from "bun:test";
import { CodeInternetOriginSchema, CodeInternetOriginsSchema } from "../contracts/code-internet";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";
import type { CodeSdkMode } from "./types";

function analyze(body: string, mode: CodeSdkMode = "personal", other: Record<string, string> = {}) {
  const sdk = generateCodeSdk([], mode === "resource" ? { mode, owner: { kind: "app", appId: "example" } } : { mode });
  return analyzeCode({
    files: {
      ...other,
      "code.ts": `import { app, http } from "@sdk";\n${body}\napp.schedule("0 8 * * 1", async () => {}); export default app;`,
    },
    entry: "code.ts",
    sdk,
    aiOperations: [],
  });
}
test("versions of every owner declare literals, imported constants and a literal authority before dynamic paths", () => {
  for (const mode of ["personal", "resource"] as const) {
    const result = analyze(
      'import { endpoint } from "./url"; const id: string = String(Date.now()); http.fetch(endpoint); http.fetch(`https://api.example/items/${id}`); http.fetch("https://api.example:8443/" + id);',
      mode,
      { "url.ts": 'export const endpoint = "https://other.example/items";' },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.internet).toEqual(["https://api.example", "https://api.example:8443", "https://other.example"]);
  }
});
test("dynamic origins require http.allow, including a partly dynamic hostname or port", () => {
  for (const url of [
    "String(Date.now())",
    "`https://${id}/items`",
    "`https://api.example${id}/items`",
    "`https://api.example:${id}/items`",
  ]) {
    const result = analyze(`const id: string = String(Date.now()); http.fetch(${url});`);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "code_http_origin_dynamic", message: expect.stringContaining("http.allow") }),
    );
  }
});
test("http.allow enumerates every destination and redirect, unions literal requests and ignores unreachable modules", () => {
  const result = analyze(
    'const url: string = String(Date.now()); http.fetch(url); http.allow(["https://api.example", "https://redirect.example:8443", "https://api.example"]); http.fetch("https://static.example/path");',
    "personal",
    { "unused.ts": 'import { http } from "@sdk"; http.allow(["https://unused.example"]);' },
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.internet).toEqual(["https://api.example", "https://redirect.example:8443", "https://static.example"]);
});
test("allow requires a literal list of canonical HTTPS origins without wildcards", () => {
  for (const value of [
    "http://api.example",
    "https://*.example",
    "https://api.example/",
    "https://api.example/path",
    "https://api.example.",
    "https://user:pass@api.example",
    "https://api.example:443",
  ]) {
    expect(CodeInternetOriginSchema.safeParse(value).success).toBe(false);
    expect(analyze(`http.allow([${JSON.stringify(value)}]);`).diagnostics).toContainEqual(
      expect.objectContaining({ code: "code_http_origin_invalid" }),
    );
  }
  expect(CodeInternetOriginSchema.safeParse("https://api.example:8443").success).toBe(true);
  expect(CodeInternetOriginsSchema.safeParse(["https://api.example", "https://api.example"]).success).toBe(false);
  expect(analyze('const origins = ["https://api.example"]; http.allow(origins);').diagnostics).toContainEqual(
    expect.objectContaining({ code: "code_http_allow_literal" }),
  );
  expect(analyze("http.allow([]); const url: string = String(Date.now()); http.fetch(url);").diagnostics).toContainEqual(
    expect.objectContaining({ code: "code_http_origin_dynamic" }),
  );
});
test("destructuring retains HTTP evidence and literal URL origins are canonicalized", () => {
  const result = analyze(
    'const { fetch: send, allow } = http; allow(["https://redirect.example"]); send("https://API.EXAMPLE:443/items");',
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.internet).toEqual(["https://api.example", "https://redirect.example"]);
});
test("code_run keeps dynamic HTTP requests for per-call review", () => {
  const result = analyzeCode({
    entry: "code.ts",
    files: {
      "code.ts":
        'import { http } from "@sdk"; export default async () => { const url: string = String(Date.now()); await http.fetch(url); };',
    },
    sdk: generateCodeSdk([], { mode: "code_run" }),
    aiOperations: [],
  });
  expect(result.diagnostics).toEqual([]);
});
