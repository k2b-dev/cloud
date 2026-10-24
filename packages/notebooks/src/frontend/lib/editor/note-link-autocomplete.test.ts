import { afterEach, expect, test } from "bun:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { buildNoteLinkCompletionSource } from "./note-link-autocomplete";

const originalFetch = globalThis.fetch;
const requests: URL[] = [];
/** The server answers with the notes whose title matches, in its order, and whether more match. */
const serve = (notes: Array<{ id: string; title: string }>, hasMore = false, status = 200) => {
  requests.length = 0;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      requests.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost"));
      return Response.json(status === 200 ? { data: notes, hasMore } : { error: "failed" }, { status });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
};
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const contextFor = (doc: string) => new CompletionContext(EditorState.create({ doc }), doc.length, false);
const complete = async (doc: string) => {
  const result = await buildNoteLinkCompletionSource("Book01")(contextFor(doc));
  return result?.options ?? null;
};
const labels = async (doc: string) => (await complete(doc))?.map((option) => option.label) ?? [];

test("the server finds the notes for what was typed, so a note far beyond the first page can be linked", async () => {
  serve([{ id: "Far001", title: "Quarry plan 19999" }]);
  expect(await labels("See [[quarry plan 1999")).toEqual(["Quarry plan 19999"]);
  expect(requests.at(-1)?.pathname).toEndWith("/Book01/titles");
  expect(requests.at(-1)?.searchParams.get("q")).toBe("quarry plan 1999");
});

test("the server's order stays, so the exact title is the first option", async () => {
  serve([
    { id: "Note01", title: "Plan" },
    { id: "Note02", title: "Plan B" },
    { id: "Note03", title: "Airplane" },
  ]);
  expect(await labels("[[plan")).toEqual(["Plan", "Plan B", "Airplane"]);
});

test("more matches than a page say so in a heading, which nothing can pick", async () => {
  serve(
    Array.from({ length: 50 }, (_, index) => ({ id: `N${String(index).padStart(5, "0")}`, title: `Note ${index}` })),
    true,
  );
  const options = await complete("[[");
  expect(requests.at(-1)?.searchParams.has("q")).toBe(false);
  expect(options).toHaveLength(50);
  const section = options?.[0]?.section;
  expect(typeof section === "object" ? section.name : section).toContain("keep typing");
  serve([{ id: "Note01", title: "Plan" }]);
  expect((await complete("[[plan"))?.[0]?.section).toBeUndefined();
});

test("no match or a failed request still answers, so the next keystroke asks again", async () => {
  serve([]);
  expect(await complete("[[plax")).toEqual([]);
  serve([], false, 500);
  expect(await complete("[[plax")).toEqual([]);
});

test("a keystroke aborts the request for the text before it", async () => {
  serve([{ id: "Note01", title: "Plan" }]);
  const context = contextFor("[[pla");
  const listeners: Array<{ options?: { onDocChange: boolean } }> = [];
  context.addEventListener = (_type, _listener, options) => listeners.push({ options });
  await buildNoteLinkCompletionSource("Book01")(context);
  expect(listeners).toEqual([{ options: { onDocChange: true } }]);
});

test("an attachment trigger asks for no notes", async () => {
  serve([{ id: "Note01", title: "Plan" }]);
  expect(await complete("![[Pl")).toBeNull();
  expect(requests).toHaveLength(0);
});
