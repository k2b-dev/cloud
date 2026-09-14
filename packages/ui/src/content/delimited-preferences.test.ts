import { expect, test } from "bun:test";
import { decodeDelimitedContent, readDelimitedPreferences } from "./delimited-preferences";
import { parseDelimitedText } from "./file-view-preview";

test("CSV original bytes can be decoded again without changing the source", () => {
  const source = { encoding: "base64" as const, content: btoa("name;price\nM\xfc ller;12,50") };
  expect(decodeDelimitedContent(source, "utf-8")).toContain("�");
  expect(parseDelimitedText(decodeDelimitedContent(source, "windows-1252"), ";").rows[1]).toEqual(["Mü ller", "12,50"]);
  expect(atob(source.content)).toContain("\xfc");
});

test("CSV preferences reject malformed storage and unsupported decoder labels", () => {
  expect(readDelimitedPreferences("{")).toEqual(readDelimitedPreferences(null));
  expect(readDelimitedPreferences('{"encoding":"invalid","delimiter":"bogus","view":"raw"}')).toEqual({
    encoding: "utf-8",
    delimiter: "auto",
    view: "raw",
  });
  expect(readDelimitedPreferences('{"encoding":"utf-16le","delimiter":";","view":"table"}').encoding).toBe("utf-16le");
});
