import { afterEach, expect, test } from "bun:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { buildNoteLinkCompletionSource } from "./note-link-autocomplete";

const originalFetch = globalThis.fetch;
const requests: URL[] = [];
/** The server answers with the notes whose title matches, as many as it found in total. */
const serve = (notes: Array<{ id: string; title: string }>, total = notes.length) => {
  requests.length = 0;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      requests.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost"));
      return Response.json({ data: notes, pagination: { page: 1, per_page: 50, total, total_pages: 1, has_next: false } });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
};
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const complete = async (doc: string) => {
  const result = await buildNoteLinkCompletionSource("Book01")(new CompletionContext(EditorState.create({ doc }), doc.length, false));
  return result?.options.map((option) => option.label) ?? [];
};

test("the server finds the notes for what was typed, so a note far beyond the first page can be linked", async () => {
  serve([{ id: "Far001", title: "Quarry plan 19999" }]);
  expect(await complete("See [[quarry plan 1999")).toEqual(["Quarry plan 19999"]);
  expect(requests.at(-1)?.searchParams.get("q")).toBe("quarry plan 1999");
  expect(requests.at(-1)?.searchParams.get("per_page")).toBe("50");
});

test("an empty trigger asks for one page, and more matches than a page say so", async () => {
  serve(
    Array.from({ length: 50 }, (_, index) => ({ id: `N${String(index).padStart(5, "0")}`, title: `Note ${index}` })),
    20_000,
  );
  const labels = await complete("[[");
  expect(requests.at(-1)?.searchParams.has("q")).toBe(false);
  expect(labels).toHaveLength(51);
  expect(labels.at(-1)).toContain("more notes");
});

test("an attachment trigger asks for no notes", async () => {
  serve([{ id: "Note01", title: "Plan" }]);
  expect(await complete("![[Pl")).toEqual([]);
  expect(requests).toHaveLength(0);
});
