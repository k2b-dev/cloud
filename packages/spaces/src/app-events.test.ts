import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { appEventFixture } from "@k2b/cloud/events/testing";
import { spacesCapabilities } from "./capabilities";

test("Spaces automation facts declare bounded data and public subject/place readers", () => {
  const manifest = compileCapabilityManifest("spaces", spacesCapabilities);
  expect(manifest.events?.map((event) => event.localId).sort()).toEqual([
    "comment.created",
    "item.completed",
    "item.created",
    "item.due",
    "item.updated",
  ]);
  for (const name of ["comment.created", "item.due", "item.updated"] as const) {
    const event = appEventFixture(
      spacesCapabilities,
      name,
      {
        subject: name === "comment.created" ? "Com001" : "Itm001",
        place: "Spc001",
        data: name === "item.updated" ? { changed: ["assignees", "due", "status"] } : {},
      },
      { appId: "spaces" },
    );
    expect(event.subject.type).toBe(name === "comment.created" ? "spaces.comment" : "spaces.item");
    expect(event.place).toEqual({ type: "spaces.space", id: "Spc001" });
    expect(Buffer.byteLength(JSON.stringify(event))).toBe({ "comment.created": 247, "item.due": 237, "item.updated": 279 }[name]);
    const declaration = spacesCapabilities.events[name];
    expect(declaration.schema.safeParse({ title: "private" }).success).toBe(false);
    expect(declaration.schema.safeParse({ content: "private" }).success).toBe(false);
  }
  const schema = spacesCapabilities.events["item.updated"].schema;
  for (const changed of [[], ["title"], ["due", "due", "due", "due"]]) {
    expect(schema.safeParse({ changed }).success).toBe(false);
  }
  expect(spacesCapabilities.types.comment.reader).toBe("comment.read");
  expect(spacesCapabilities.types.item.reader).toBe("item.read");
  expect(spacesCapabilities.types.space.reader).toBe("space.read");
});

test("comment and tag actions expose explicit shared policies in the public manifest", () => {
  const manifest = compileCapabilityManifest("spaces", spacesCapabilities);
  for (const name of ["comment.create", "item.tags.set", "task.update"]) {
    expect(manifest.policies?.[name]).toEqual({ silent: "shared" });
  }
  for (const name of ["comment.delete", "item.delete", "template.delete"]) {
    expect(manifest.actions.some((action) => action.localId === name)).toBe(true);
    expect(manifest.policies?.[name]).not.toEqual({ silent: "shared" });
  }
});
