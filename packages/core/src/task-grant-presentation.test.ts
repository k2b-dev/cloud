import { expect, spyOn, test } from "bun:test";
import * as catalog from "@k2b/cloud/capabilities/server";
import type { AppRegistryEntry } from "@k2b/cloud/contracts/registry";
import * as registry from "../../cloud/src/_internal/registry";
import { recentTestApp, recentTestAuthority, recentTestRegistryApp } from "../../cloud/src/ai/recent-resources.test-fixture";
import { taskGrantReview } from "./task-grant-presentation";

test("task access review distinguishes unrestricted inputs, exact restrictions and no access", async () => {
  const lookup = spyOn(catalog, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: null });
  try {
    const none = await taskGrantReview([], "de");
    expect(none.value).toBe("Keine zusätzlichen Zugriffe.");
    const review = await taskGrantReview(
      [
        { appId: "spaces", capabilityId: "event.agenda", kind: "query", fixedInput: {} },
        { appId: "notebooks", capabilityId: "note.update", kind: "action", fixedInput: { noteId: "abc123" } },
      ],
      "de",
    );
    expect(review.format).toBe("markdown");
    expect(review.value).toContain("**event\\.agenda**");
    expect(review.label).toBe("Das erlaubst du dieser Routine");
    expect(review.value).not.toContain("Aktion ausführen");
    expect(review.value).toContain("Keine Einschränkung auf bestimmte Inhalte");
    expect(review.value).toContain("noteId: abc123");
    expect(review.value.split("\n\n")[1]).toBe(
      "**note\\.update** · notebooks  \nFestgelegt: noteId: abc123\\. Andere Eingaben darf die Routine selbst wählen\\.",
    );
    expect(review.value).not.toContain('"fixedInput"');
    expect(lookup).toHaveBeenCalledWith("spaces", "de", null);
  } finally {
    lookup.mockRestore();
  }
});

test("HTTP and database grants share the compact human-readable access review", async () => {
  const review = await taskGrantReview(
    [
      { kind: "http", fixedInput: { origin: "https://api.example.com", method: "GET" } },
      { kind: "database", fixedInput: { resourceId: "aBc234", table: "invoices" } },
    ],
    "de",
  );
  expect(review.value).toContain("**HTTP\\-Anfragen senden** · HTTP");
  expect(review.value).toContain("Methode: GET");
  expect(review.value).toContain("Studio\\-App: aBc234");
  expect(review.value).toContain("Tabelle: invoices");
  expect(review.value).not.toContain("fixedInput");
});

test("task grant review presents an allowed declared app and falls back after revocation or scope denial", async () => {
  const app: AppRegistryEntry = { ...recentTestRegistryApp, access: { kind: "signedIn" } };
  const lookups = [
    spyOn(registry, "getApp").mockImplementation(async () => app),
    spyOn(registry, "getCapability").mockResolvedValue(recentTestApp),
  ];
  const grants = [{ appId: "demo", capabilityId: "item.read", kind: "query" as const, fixedInput: {} }];
  try {
    expect((await taskGrantReview(grants, "en", recentTestAuthority)).value).toContain("**Read item** · Demo");
    app.access = { kind: "roles", roles: ["admin"] };
    expect((await taskGrantReview(grants, "en", recentTestAuthority)).value).toContain("**item\\.read** · demo");
    app.access = { kind: "signedIn" };
    expect((await taskGrantReview(grants, "en", { ...recentTestAuthority, scopes: ["core:read"] })).value).toContain(
      "**item\\.read** · demo",
    );
    expect((await taskGrantReview(grants, "en")).value).toContain("**item\\.read** · demo");
  } finally {
    for (const lookup of lookups) lookup.mockRestore();
  }
});
