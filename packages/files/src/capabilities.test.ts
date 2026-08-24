import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { compileCapabilityManifest } from "@valentinkolb/cloud/capabilities/testing";
import {
  type CapabilityExecutionContext,
  UniversalSearchDataSchema,
  UniversalSearchInputSchema,
  type User,
} from "@valentinkolb/cloud/contracts";
import { filesCapabilities } from "./capabilities";
import { filesService } from "./service";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "files-capability",
  roles: ["user", "ipa", "ipa/user"],
  provider: "ipa",
  profile: "user",
  givenname: "Files",
  sn: "Capability",
  displayName: "Files Capability",
  mail: "files-capability@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: {
    uidNumber: null,
    phone: null,
    employeeType: null,
    mobile: null,
    address: { street: null, postalCode: null, city: null, state: null },
    passwordExpires: null,
    lastLoginIpa: null,
    syncedAt: null,
    sshPublicKeys: [],
    sshFingerprints: [],
  },
};

const context: CapabilityExecutionContext = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  user,
  locale: "en",
  signal: new AbortController().signal,
};

afterEach(() => mock.restore());

describe("files capabilities", () => {
  test("declares the registered, navigable search surface", () => {
    expect(Object.keys(filesCapabilities.types).sort()).toEqual(["directory", "file"]);
    expect(Object.keys(filesCapabilities.queries).sort()).toEqual(["directory.read", "file.read", "search"]);
    expect(filesCapabilities.types.file.reader).toBe("file.read");
    expect(filesCapabilities.types.directory.reader).toBe("directory.read");
    expect(filesCapabilities.queries.search.input).toBe(UniversalSearchInputSchema);
    expect(filesCapabilities.queries.search.data).toBe(UniversalSearchDataSchema);
    expect(compileCapabilityManifest("files", filesCapabilities).types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ localId: "file", reader: "file.read" }),
        expect.objectContaining({ localId: "directory", reader: "directory.read" }),
      ]),
    );
  });

  test("returns stable open and preview links for matching files", async () => {
    spyOn(filesService.base, "listResolved").mockResolvedValue([{ type: "home", uid: user.uid }]);
    spyOn(filesService.search, "list").mockResolvedValue({
      ok: true,
      data: {
        results: [
          {
            base: { type: "home", id: user.uid, name: "Home" },
            files: [{ type: "file", name: "avatar.png", path: "/Pictures/avatar.png", mimeType: "image/png" }],
          },
        ],
      },
    } as Awaited<ReturnType<typeof filesService.search.list>>);

    const result = await filesCapabilities.queries.search.run({ query: "avatar", tags: [], limit: 10 }, context);

    expect(result).toMatchObject({
      ok: true,
      data: {
        data: [
          {
            ref: { type: "files.file", id: "home:files-capability:/Pictures/avatar.png" },
            links: [
              { rel: "open", href: "/app/files/home/Pictures/avatar.png" },
              {
                rel: "preview",
                href: "/api/files/home/files-capability/thumbnail?path=%2FPictures%2Favatar.png",
              },
            ],
          },
        ],
      },
    });
  });

  test("reads file and directory refs as bounded metadata", async () => {
    spyOn(filesService.base, "get").mockResolvedValue({
      ok: true,
      data: { type: "home", uid: user.uid, uidNumber: 1000, gidNumber: 1000 },
    });
    spyOn(filesService.base.permission, "canAccess").mockResolvedValue({ ok: true, data: undefined });
    spyOn(filesService.item, "get")
      .mockResolvedValueOnce({
        ok: true,
        data: {
          type: "file",
          name: "report.pdf",
          path: "/Reports/report.pdf",
          size: 42,
          mtime: "2026-08-20T12:00:00.000Z",
          isHidden: false,
          mimeType: "application/pdf",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          type: "directory",
          name: "Reports",
          path: "/Reports",
          size: 0,
          mtime: "2026-08-20T12:00:00.000Z",
          isHidden: false,
          items: [],
          total: 3,
        },
      });

    const file = await filesCapabilities.queries["file.read"].run({ id: "home:files-capability:/Reports/report.pdf" }, context);
    const directory = await filesCapabilities.queries["directory.read"].run({ id: "home:files-capability:/Reports" }, context);

    expect(file).toMatchObject({
      ok: true,
      data: {
        data: { type: "file", name: "report.pdf", base: { type: "home", id: user.uid, name: "Home" }, size: 42 },
        summary: "Read file “report.pdf”.",
        refs: [
          {
            type: "files.file",
            id: "home:files-capability:/Reports/report.pdf",
            title: "report.pdf",
            preview: "Home • /Reports/report.pdf",
            icon: "ti ti-file",
          },
        ],
      },
    });
    expect(directory).toMatchObject({
      ok: true,
      data: {
        data: { type: "directory", name: "Reports", itemCount: 3 },
        summary: "Read directory “Reports” with 3 items.",
        refs: [
          {
            type: "files.directory",
            id: "home:files-capability:/Reports",
            title: "Reports",
            preview: "Home • /Reports",
            icon: "ti ti-folder",
          },
        ],
      },
    });
  });

  test("rejects malformed refs and reports a changed resource type", async () => {
    expect(await filesCapabilities.queries["file.read"].run({ id: "not-a-ref" }, context)).toMatchObject({
      ok: false,
      error: { code: "BAD_INPUT", message: expect.stringContaining("Search files") },
    });

    spyOn(filesService.base, "get").mockResolvedValue({
      ok: true,
      data: { type: "home", uid: user.uid, uidNumber: 1000, gidNumber: 1000 },
    });
    spyOn(filesService.base.permission, "canAccess").mockResolvedValue({ ok: true, data: undefined });
    spyOn(filesService.item, "get").mockResolvedValue({
      ok: true,
      data: {
        type: "directory",
        name: "report.pdf",
        path: "/Reports/report.pdf",
        size: 0,
        mtime: "2026-08-20T12:00:00.000Z",
        isHidden: false,
        items: [],
        total: 0,
      },
    });

    expect(await filesCapabilities.queries["file.read"].run({ id: "home:files-capability:/Reports/report.pdf" }, context)).toMatchObject({
      ok: false,
      error: { code: "BAD_INPUT", message: expect.stringContaining("files.directory ref") },
    });
  });
});
