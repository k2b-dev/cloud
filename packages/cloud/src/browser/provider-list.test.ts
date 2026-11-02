import { describe, expect, test } from "bun:test";
import { FileProviderError } from "./file-provider-error";
import type { FileProviderSource } from "./file-providers";
import { createProviderList } from "./provider-list";

const source = (appId: string): FileProviderSource => ({
  appId,
  name: appId,
  icon: "ti ti-folders",
  list: "folder.list",
  context: false,
  read: "file.read",
  maxBytes: 1_000,
});

describe("one page's provider list", () => {
  test("a refresh reads the catalog behind the kept list, once at a time, and replaces it", async () => {
    const answers = [[source("drive")], [source("drive"), source("vault")]];
    let loads = 0;
    const list = createProviderList(async () => answers[loads++]!);
    await list.providers();
    expect(list.known()?.map((entry) => entry.appId)).toEqual(["drive"]);
    const first = list.refresh();
    expect(list.refresh()).toBe(first);
    expect(list.known()?.map((entry) => entry.appId)).toEqual(["drive"]);
    expect((await first).map((entry) => entry.appId)).toEqual(["drive", "vault"]);
    expect(list.known()?.map((entry) => entry.appId)).toEqual(["drive", "vault"]);
    expect((await list.providers()).length).toBe(2);
    expect(loads).toBe(2);
  });

  test("a failed refresh keeps the list; a refused one empties it and asks again next time", async () => {
    const answers: (() => Promise<FileProviderSource[]>)[] = [
      async () => [source("drive")],
      async () => {
        throw new TypeError("Failed to fetch");
      },
      async () => {
        throw new FileProviderError("UNAUTHORIZED", "Sign in", 401);
      },
    ];
    let loads = 0;
    const list = createProviderList(() => answers[loads++]!());
    await list.providers();
    expect((await list.refresh()).map((entry) => entry.appId)).toEqual(["drive"]);
    expect(list.known()?.length).toBe(1);
    expect(list.requested()).toBe(true);
    expect(await list.refresh()).toEqual([]);
    expect(list.known()).toEqual([]);
    expect(list.requested()).toBe(false);
  });

  test("without a kept list, a refresh is the first load", async () => {
    let loads = 0;
    const list = createProviderList(async () => {
      loads++;
      return [source("drive")];
    });
    expect((await list.refresh()).length).toBe(1);
    expect(loads).toBe(1);
  });
});
