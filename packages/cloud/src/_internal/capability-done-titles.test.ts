import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { type CapabilityPresentationCatalog, defineCapabilities } from "../contracts/capabilities";
import { compileCapabilities, compileCapabilityPresentation, resolveCapabilityQueryDoneTitle } from "./capabilities";

/** One Query and one Action; the past form of the Query is under test. */
const app = (presentation?: unknown) =>
  defineCapabilities({
    protocolVersion: 2,
    presentation: presentation as CapabilityPresentationCatalog,
    queries: {
      search: {
        title: "Search mail",
        description: "Searches mail.",
        input: z.object({ query: z.string().max(100).describe("Words.") }).strict(),
        data: z.array(z.object({ id: z.string() })),
        openWorld: false,
        run: async () => ok({ data: [] }),
      },
    },
    actions: {
      send: {
        title: "Send email",
        description: "Sends one email.",
        input: z.object({ subject: z.string().max(200).describe("Subject line.") }).strict(),
        data: z.object({ messageId: z.string() }).strict(),
        destructive: false,
        openWorld: false,
        idempotency: "required",
        run: async () => ok({ data: { messageId: "M-1" } }),
      },
    },
  });

const compile = (presentation: unknown) => compileCapabilities("acme", app(presentation));

const catalog = {
  baseLocale: "en",
  doneTitles: { search: " Searched mail " },
  translations: { de: { queries: { search: { title: "In Mail suchen", doneTitle: "In Mail gesucht" } } } },
};

describe("past forms of Queries", () => {
  test("an app gives each Query a past form in its base locale and in each translation", () => {
    const { manifest, presentation } = compile(catalog);
    expect(presentation?.doneTitles).toEqual({ search: "Searched mail" });
    expect(presentation?.translations.de?.queries?.search).toEqual({ title: "In Mail suchen", doneTitle: "In Mail gesucht" });
    // The manifest stays as it was: a past form is presentation, so older readers keep the Query.
    expect(JSON.stringify(manifest)).not.toContain("Searched mail");
  });

  test("the past form comes from the locale of the title, so a step never mixes two languages", () => {
    const { manifest, presentation } = compile(catalog);
    const search = manifest.queries[0]!;
    expect(resolveCapabilityQueryDoneTitle(search, presentation, "de-AT")).toBe("In Mail gesucht");
    expect(resolveCapabilityQueryDoneTitle(search, presentation, "en")).toBe("Searched mail");
    expect(resolveCapabilityQueryDoneTitle(search, presentation, "fr")).toBe("Searched mail");
    // A translation that words the title but gives no past form leaves the chat's neutral form, not English.
    const titleOnly = compile({ ...catalog, translations: { de: { queries: { search: { title: "In Mail suchen" } } } } });
    expect(resolveCapabilityQueryDoneTitle(search, titleOnly.presentation, "de")).toBeUndefined();
    expect(resolveCapabilityQueryDoneTitle(search, undefined, "en")).toBeUndefined();
  });

  test("a producer may give past forms only to Queries it declares", () => {
    expect(() => compile({ ...catalog, doneTitles: { missing: "Gone" } })).toThrow('unknown localId "missing"');
    expect(() => compile({ ...catalog, doneTitles: { search: "" } })).toThrow();
    expect(() => compile({ baseLocale: "en", translations: { de: { actions: { send: { doneTitle: "Gesendet" } } } } })).toThrow(
      'unsupported field "doneTitle"',
    );
  });

  test("a reader of a newer or broken producer keeps the Query's other copy and drops only an unusable past form", () => {
    const { manifest } = compile(undefined);
    const read = compileCapabilityPresentation(
      manifest,
      {
        baseLocale: "en",
        doneTitles: { search: 42, missing: "Gone" },
        translations: { de: { queries: { search: { title: "In Mail suchen", doneTitle: ["x"] } } } },
      },
      "reader",
    );
    expect(read?.doneTitles).toBeUndefined();
    expect(read?.translations.de?.queries?.search).toEqual({ title: "In Mail suchen" });
  });
});
