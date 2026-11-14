import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { appEventFixture } from "@k2b/cloud/events/testing";
import { notebooksCapabilities } from "./capabilities";

test("page discussion events expose only public comment and notebook references", () => {
  const manifest = compileCapabilityManifest("notebooks", notebooksCapabilities);
  expect(manifest.events?.find((event) => event.localId === "comment.created")).toMatchObject({
    version: 1,
    subject: "comment",
    place: "notebook",
  });
  const event = appEventFixture(
    notebooksCapabilities,
    "comment.created",
    { subject: "Com001", place: "Bok001", data: {} },
    { appId: "notebooks" },
  );
  expect(event.subject).toEqual({ type: "notebooks.comment", id: "Com001" });
  expect(event.place).toEqual({ type: "notebooks.notebook", id: "Bok001" });
  expect(event.data).toEqual({});
  expect(Buffer.byteLength(JSON.stringify(event))).toBe(262);
  expect(notebooksCapabilities.types.comment.reader).toBe("comment.read");
  expect(notebooksCapabilities.events["comment.created"].schema.safeParse({ content: "private" }).success).toBe(false);
});

test("only comment and note creation gain shared silent policies", () => {
  const manifest = compileCapabilityManifest("notebooks", notebooksCapabilities);
  for (const name of ["comment.create", "note.create"]) expect(manifest.policies?.[name]).toEqual({ silent: "shared" });
  for (const name of ["comment.delete", "note.move", "note.delete"]) expect(manifest.policies?.[name]).toBeUndefined();
});
