import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gatewayOpsApiErrorMessage, gatewayOpsMessages } from "./messages";

test("Gateway operations messages contain matching locale contracts", () => {
  expect(gatewayOpsMessages.check()).toEqual([]);
});

test("Gateway API messages isolate concurrent request locales", async () => {
  const [english, german] = await Promise.all([
    Promise.resolve().then(() => gatewayOpsApiErrorMessage(500, "en")),
    Promise.resolve().then(() => gatewayOpsApiErrorMessage(500, "de-CH")),
  ]);
  expect(english).toBe("The Gateway operation failed");
  expect(german).toBe("Der Gateway-Vorgang ist fehlgeschlagen");
});

test("numbers in the texts read as the request's locale writes them", () => {
  const de = gatewayOpsMessages.resolve(["de"]).t;
  const en = gatewayOpsMessages.resolve(["en"]).t;
  expect(de.serverErrorCount({ count: 1_234_567 })).toBe("1.234.567 Serverfehler");
  expect(en.serverErrorCount({ count: 1_234_567 })).toBe("1,234,567 server errors");
  expect(de.failedRunsTitle({ count: 98_765 })).toBe("98.765 fehlgeschlagene Ausführungen");
  expect(de.criticalSignalsDetected({ critical: 1_200, unavailable: 1 })).toContain("1.200");
});

test("no text puts a number parameter into its words unformatted", () => {
  // A message that takes a number writes it through the catalog's locale helpers; a bare \${count} reads "1234567".
  const source = readFileSync(new URL("./messages.ts", import.meta.url), "utf8");
  const english = source.slice(source.indexOf("\n    en: {"), source.indexOf("\n    de: {"));
  const raw: string[] = [];
  for (const [, key, names] of english.matchAll(/\n {6}(\w+): \(\{[^}]*\}: \{([^}]*)\}\)/g)) {
    const numeric = names!
      .split(";")
      .map((part) => part.trim())
      .filter((part) => /:\s*number(\s*\|\s*null)?$/.test(part))
      .map((part) => part.split(":")[0]!.trim().replace(/\?$/, ""));
    for (const locale of ["en", "de"]) {
      const block = locale === "en" ? english : source.slice(source.indexOf("\n    de: {"));
      const start = block.indexOf(`\n      ${key}: `);
      // up to the next message: continuation lines stand deeper
      const next = block.slice(start + 1).search(/\n {6}\w+: /);
      const body = block.slice(start, next === -1 ? undefined : start + 1 + next);
      // an identifier such as a revision is no amount
      for (const name of numeric) if (name !== "revision" && body.includes(`\${${name}}`)) raw.push(`${locale}.${key}: ${name}`);
    }
  }
  expect(raw).toEqual([]);
});
