import { describe, expect, test } from "bun:test";
import { browserMessages } from "./browser-messages";
import { defaultView } from "./browser-preferences";
import { browseOf, folderQueries, legacyFolderHref, preferenceOf, readFolderAddress, searchOf } from "./folder-query";

const queries = folderQueries(browserMessages.resolve(["en"]).t);
const read = (query: string, preference = defaultView) => readFolderAddress(queries, new URLSearchParams(query), preference);

describe("folder addresses on v2", () => {
  test("a folder without list parameters takes the storage's remembered view", () => {
    const address = read("base=team&path=Projects", { ...defaultView, sort: "modified", direction: "desc", type: "files" });
    expect(address.mode).toBe("folder");
    expect(address.mode === "folder" && browseOf(address.state)).toEqual({
      sort: "modified",
      order: "desc",
      type: "files",
      groupFolders: true,
    });
  });

  test("the address wins over the remembered view, and the view it leaves is remembered", () => {
    const address = read("base=team&sort=size.desc&type=directories", { ...defaultView, groupFolders: false });
    if (address.mode !== "folder") throw new Error("expected a folder");
    expect(browseOf(address.state)).toEqual({ sort: "size", order: "desc", type: "directories", groupFolders: false });
    expect(preferenceOf(address.state, defaultView)).toMatchObject({
      sort: "size",
      direction: "desc",
      type: "directories",
      groupFolders: false,
    });
  });

  test("a search word makes a search ranked by best match; filters alone search below the folder in its order", () => {
    const words = read("base=team&path=Projects&q=budget&kind=sheet");
    expect(words.mode).toBe("search");
    expect(searchOf(words, new URLSearchParams("q=budget"))).toMatchObject({
      q: "budget",
      kind: "sheet",
      scope: "tree",
      sort: "relevance",
    });
    const filters = read("base=team&path=Projects&kind=pdf&modified=week");
    expect(filters.mode).toBe("folder");
    expect(searchOf(filters, new URLSearchParams())).toMatchObject({ q: "", kind: "pdf", modified: "week", sort: "name", order: "asc" });
    expect(searchOf(read("base=team&type=files"), new URLSearchParams())).toBeNull();
  });

  test("exact names and a folder-only search keep their meaning", () => {
    const params = new URLSearchParams("q=report&match=exact&scope=folder");
    const address = readFolderAddress(queries, params, defaultView);
    expect(searchOf(address, params)).toMatchObject({ exact: true, scope: "folder" });
  });

  test("addresses from before v2 lead to the same list in the list query's words", () => {
    expect(legacyFolderHref(new URLSearchParams("base=team&path=A&sort=modified&order=desc&type=all&groupFolders=true&file=A%2Fx"))).toBe(
      "/app/filesv2?base=team&path=A&file=A%2Fx&sort=modified.desc&group=kind",
    );
    expect(legacyFolderHref(new URLSearchParams("base=team&q=budget&sort=relevance&match=exact&in=name"))).toBe(
      "/app/filesv2?base=team&q=budget&match=exact",
    );
    expect(legacyFolderHref(new URLSearchParams("base=team&sort=size.desc&group=kind"))).toBeNull();
    expect(legacyFolderHref(new URLSearchParams("base=team&path=A"))).toBeNull();
  });
});
