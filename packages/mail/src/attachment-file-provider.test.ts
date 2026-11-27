import { describe, expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { CapabilityCatalogAppSchema, fileProviderAcceptsContext, fileProviderIssues, fileProviderSearchesTree } from "@k2b/cloud/contracts";
import { mailCapabilities } from "./capabilities";
import { MAX_DRAFT_ATTACHMENT_BYTES } from "./contracts";
import { providerName } from "./service/attachment-files";

describe("Mail as a source of the file chooser", () => {
  // The manifest as Core's catalog hands it to the chooser, under the name Mail declares in config.ts.
  const catalogApp = CapabilityCatalogAppSchema.parse({
    appId: "mail",
    appName: "Mail",
    appIcon: "ti ti-mail",
    appDescription: "",
    manifest: compileCapabilityManifest("mail", mailCapabilities),
  });

  test("the catalog carries a read-only provider named Mail that the chooser lists", () => {
    const { manifest } = catalogApp;
    // The chooser keeps an app whose list and read match the contract and whose read streams (fileProviderSources).
    expect(manifest.fileProvider).toEqual({ list: "attachment.files.list", read: "attachment.content.read" });
    expect(fileProviderIssues(manifest)).toEqual([]);
    const read = manifest.queries.find((query) => query.localId === manifest.fileProvider?.read);
    expect(read?.stream).toMatchObject({ direction: "read", maxBytes: MAX_DRAFT_ATTACHMENT_BYTES });
    expect(manifest.queries.some((query) => query.localId === manifest.fileProvider?.list)).toBe(true);
    // Without a title of its own the source carries the app's name; without save it is not a place to save into.
    expect(manifest.fileProvider?.title ?? catalogApp.appName).toBe("Mail");
    expect(manifest.fileProvider?.save).toBeUndefined();
    expect(fileProviderSearchesTree(manifest)).toBe(false);
    expect(fileProviderAcceptsContext(manifest)).toBe(false);
  });

  test("names stay within the contract by the chooser's cleaning rule", () => {
    expect(providerName("invoice‮fdp.exe", "file")).toBe("invoicefdp.exe");
    expect(providerName("a/b\\c\u0000.pdf", "file")).toBe("abc.pdf");
    expect(providerName("  ", "Unnamed attachment")).toBe("Unnamed attachment");
    expect(providerName(null, "Unnamed attachment")).toBe("Unnamed attachment");
    expect(providerName("..", "file")).toBe("file");
    const long = providerName(`${"ä".repeat(300)}.pdf`, "file");
    expect(long).toHaveLength(255);
    expect(long.endsWith(".pdf")).toBe(true);
    const emoji = providerName(`${"😀".repeat(200)}.txt`, "file");
    expect(emoji.length).toBeLessThanOrEqual(255);
    expect(emoji.endsWith(".txt")).toBe(true);
    expect(emoji).not.toContain("�");
  });
});
