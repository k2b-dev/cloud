import { expect, test } from "bun:test";
import { SETTINGS_MAP, validateSettingValue } from "./defaults";

const definition = SETTINGS_MAP.get("app.documentation_url")!;

test("documentation base uses the public default and accepts local and prefixed mirrors", () => {
  expect(definition.default).toBe("https://cloud.k2b.dev");
  for (const url of ["https://cloud.k2b.dev", "http://localhost:4187", "https://docs.example.org/cloud"]) {
    expect(validateSettingValue(definition, ` ${url}/ `)).toEqual({ ok: true, value: url });
  }
});

test("documentation base rejects unsafe or non-base URLs at the shared setting boundary", () => {
  for (const url of [
    "",
    "//example.org",
    "/docs",
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/docs",
    "https://user:password@example.org",
    "https://example.org?q=secret",
    "https://example.org#part",
    123,
  ]) {
    expect(validateSettingValue(definition, url).ok).toBe(false);
  }
});
