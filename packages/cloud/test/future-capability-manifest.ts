import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { capabilityHash, compileCapabilities } from "../src/_internal/capabilities";
import { defineCapabilities, UniversalSearchDataSchema, UniversalSearchInputSchema } from "../src/contracts/capabilities";

const byId = z.object({ id: z.string().max(100).describe("Stable id.") }).strict();
const named = z.object({ id: z.string(), name: z.string() }).strict();
const read = (title: string) => ({
  title,
  description: `${title} by its stable id.`,
  input: byId,
  data: named,
  openWorld: false,
  run: async ({ id }: { id: string }) => ok({ data: { id, name: "Example" } }),
});
const change = (title: string) => ({
  title,
  description: `${title}.`,
  input: z.object({ id: z.string().max(100).describe("Stable book id.") }).strict(),
  data: z.object({ id: z.string() }).strict(),
  destructive: false,
  openWorld: false,
  idempotency: "required" as const,
  approval: "rememberable" as const,
  review: async ({ id }: { id: string }) => ok({ message: `${title}?`, approvalScope: `book:${id}` }),
  run: async ({ id }: { id: string }) => ok({ data: { id } }),
});

/** The library app as this release compiles it. */
export const currentLibrary = compileCapabilities(
  "library",
  defineCapabilities({
    protocolVersion: 2,
    types: {
      author: { title: "Author", description: "One author.", reader: "author.read" },
      book: { title: "Book", description: "One book.", reader: "book.read" },
      shelf: { title: "Shelf", description: "One shelf." },
    },
    queries: {
      "author.read": read("Read author"),
      "book.read": read("Read book"),
      "book.search": {
        title: "Search books",
        description: "Search books on one shelf.",
        input: UniversalSearchInputSchema,
        data: UniversalSearchDataSchema,
        openWorld: false,
        universalSearch: { tags: [{ tag: "book", title: "Books", description: "Find books." }], scopeTypes: ["shelf"] },
        run: async () => ok({ data: [] }),
      },
    },
    actions: { "book.archive": change("Archive book"), "book.rename": change("Rename book") },
    commands: { "book.open": { title: "Open book", description: "Open one book.", input: byId, path: "/app/library" } },
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          types: { book: { title: "Buch" } },
          queries: { "author.read": { title: "Autor lesen" }, "book.read": { title: "Buch lesen" } },
          actions: { "book.archive": { title: "Buch archivieren" } },
        },
      },
    },
  }),
);

/**
 * The same app as a newer Cloud release could register it: new top-level fields, plus new fields and
 * values inside existing entries, hashed the way that newer producer hashes its manifest.
 */
export const futureLibrary = () => {
  const { manifestHash: _current, ...current } = structuredClone(currentLibrary.manifest);
  const base = {
    ...current,
    fileProvider: { list: "book.search", read: "book.read" },
    events: [{ localId: "book.changed", title: "Book changed", dataSchema: { type: "object" } }],
    // A type with a field this release does not know; the Universal Search Query scoped to it depends on it.
    types: current.types.map((type) => (type.localId === "shelf" ? { ...type, nesting: "rooms" } : type)),
    // A Query with an unknown field. It is the reader of `author`.
    queries: current.queries.map((query) => (query.localId === "author.read" ? { ...query, delivery: "events" } : query)),
    // An Action with an approval value this release does not know; reading it as unapproved would widen access.
    actions: current.actions.map((action) => (action.localId === "book.archive" ? { ...action, approval: "always" } : action)),
  };
  const presentation = {
    baseLocale: "en",
    glossary: { de: { book: "Buch" } },
    translations: {
      de: {
        types: { book: { title: "Buch" } },
        queries: { "author.read": { title: "Autor lesen" }, "book.read": { title: "Buch lesen", hint: "Neu" } },
        actions: { "book.archive": { title: "Buch archivieren" } },
        // Search tags for a Command, which this release does not support.
        commands: { "book.open": { title: "Buch öffnen", searchTags: { book: { title: "Bücher" } } } },
        events: { "book.changed": { title: "Buch geändert" } },
      },
    },
  };
  return { manifest: { ...base, manifestHash: capabilityHash(base) }, presentation };
};
