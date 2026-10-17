import { afterEach, expect, mock, test } from "bun:test";
import type { ChatCommandContext } from "@k2b/ui";
import type { CloudResourcePickerItem, CloudResourcePickerOptions } from "./resource-picker";

const picker = mock<(options?: CloudResourcePickerOptions) => Promise<CloudResourcePickerItem | undefined>>(async () => undefined);
mock.module("./resource-picker", () => ({ openCloudResourcePicker: picker }));
const { cloudInsertMenu } = await import("./composer-insert");
afterEach(() => picker.mockReset());
const context: ChatCommandContext = { setValue() {}, submit() {}, focus() {}, openModelSelection: async () => null };
const note = {
  appId: "notebooks",
  appName: "Notebooks",
  appIcon: "ti ti-notebook",
  tag: "note",
  title: "Notizen",
  description: "",
  aliases: ["notes", "markdown", "file"],
};
const mention = { id: "note-1", name: "Q3" };
const excluded = [{ type: "notebooks.note", id: "existing" }];
const menu = (locale = "de") =>
  cloudInsertMenu({
    locale,
    tags: [{ ...note, title: locale === "de" ? "Notizen" : "Notes" }],
    section: "insert",
    reservedWords: ["file"],
    excludeRefs: () => excluded,
    mention: () => mention,
  });

test.each(["de", "en"])("tag rows keep localized presentation and searchable metadata (%s)", (locale) => {
  const result = menu(locale);
  expect(result.tags[0]).toMatchObject({
    label: locale === "de" ? "Notizen" : "Notes",
    description: locale === "de" ? "Aus Notebooks wählen" : "Choose from Notebooks",
    app: "Notebooks",
    hiddenUntilSearch: true,
    section: "insert",
  });
  expect(result.tags[0]!.keywords).toEqual(
    expect.arrayContaining([locale === "de" ? "Notizen" : "Notes", "Notebooks", "note", "notes", "markdown"]),
  );
  expect(result.scopes[0]).toMatchObject({
    title: locale === "de" ? "Notizen aus Notebooks" : "Notes from Notebooks",
    words: locale === "de" ? ["notizen", "note", "notes", "markdown"] : ["notes", "note", "markdown"],
  });
});

test("fallback exists only for Cloud scopes or nonempty unscoped searches", () => {
  const result = menu();
  const scope = result.scopes[0]!.id;
  expect(result.fallback({ scope, query: "q3" })?.label).toBe("„q3“ in Notizen suchen");
  expect(result.fallback({ scope, query: "" })?.label).toBe("Notizen durchsuchen");
  expect(result.fallback({ query: "q3" })?.label).toBe("„q3“ in Cloud suchen");
  expect(result.fallback({ query: "" })).toBeUndefined();
  expect(result.fallback({ scope: "skill", query: "q3" })).toBeUndefined();
});

test("row selection forwards the reader restriction, display chip, exclusions and query; returns a mention or cancellation", async () => {
  const result = menu();
  const item: CloudResourcePickerItem = {
    ref: { type: "notebooks.note", id: "Q3note" },
    title: "Q3",
    appId: "notebooks",
    appName: "Notebooks",
    appIcon: "ti ti-notebook",
    href: "/open/notebooks/note/Q3note",
    readable: true,
  };
  picker.mockResolvedValue(item);
  expect(await result.tags[0]!.action!(context)).toEqual({ mention });
  expect(picker).toHaveBeenLastCalledWith({
    scope: { appId: "notebooks", tag: "note", label: "Notizen · Notebooks", icon: "ti ti-notebook" },
    query: undefined,
    requireReader: true,
    excludeRefs: excluded,
    title: "Notizen einfügen",
  });
  await result.fallback({ scope: result.scopes[0]!.id, query: "q3" })!.action!(context);
  expect(picker.mock.calls.at(-1)?.[0]?.query).toBe("q3");
  picker.mockResolvedValue(undefined);
  expect(await result.insert.action!(context)).toBe("cancelled");
  await result.fallback({ query: "xylo" })!.action!(context);
  expect(picker).toHaveBeenLastCalledWith({
    title: "Aus Cloud einfügen",
    scope: undefined,
    query: "xylo",
    requireReader: true,
    excludeRefs: excluded,
  });
});

test("a word two tags share narrows to neither, so Tab never writes an ambiguous word", () => {
  const files = {
    appId: "files",
    appName: "Files",
    appIcon: "ti ti-folder",
    tag: "file",
    title: "Dateien",
    description: "",
    aliases: ["files"],
  };
  const drive = { ...files, appId: "drive", appName: "Drive", aliases: ["drive"] };
  const result = cloudInsertMenu({ locale: "de", tags: [files, drive], mention: () => mention });
  expect(result.scopes.map((scope) => [scope.id, scope.words])).toEqual([
    ["cloud-tag:files:file", ["files"]],
    ["cloud-tag:drive:file", ["drive"]],
  ]);
});

test("an own reader lists only its type, without a reader, even once the chip is gone", async () => {
  const studio = {
    appId: "assistant",
    appName: "Assistent",
    appIcon: "ti ti-sparkles",
    tag: "studio-app",
    title: "Studio-Apps",
    description: "",
    aliases: [],
  };
  const result = cloudInsertMenu({
    locale: "de",
    tags: [studio],
    ownReaders: { "assistant:studio-app": "assistant.app" },
    mention: () => mention,
  });
  await result.tags[0]!.action!(context);
  expect(picker.mock.calls[0]![0]).toMatchObject({ resourceType: "assistant.app" });
  expect(picker.mock.calls[0]![0]!.requireReader).toBeUndefined();
  await result.insert.action!(context);
  expect(picker.mock.calls[1]![0]).toMatchObject({ requireReader: true });
  expect(picker.mock.calls[1]![0]!.resourceType).toBeUndefined();
});
