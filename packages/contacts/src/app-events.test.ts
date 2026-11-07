import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { appEventFixture } from "@k2b/cloud/events/testing";
import { CONTACT_FIELD_GROUPS } from "./app-events";
import { contactsCapabilities } from "./capabilities";

test("Contacts events name only public contact/book references and changed field groups", () => {
  const manifest = compileCapabilityManifest("contacts", contactsCapabilities);
  expect(manifest.events?.map((event) => event.localId).sort()).toEqual(["contact.created", "contact.updated"]);
  for (const name of ["contact.created", "contact.updated"] as const) {
    const event = appEventFixture(
      contactsCapabilities,
      name,
      { subject: "Cnt001", place: "Bok001", data: name === "contact.updated" ? { changed: [...CONTACT_FIELD_GROUPS] } : {} },
      { appId: "contacts" },
    );
    expect(event.subject).toEqual({ type: "contacts.contact", id: "Cnt001" });
    expect(event.place).toEqual({ type: "contacts.book", id: "Bok001" });
    expect(Buffer.byteLength(JSON.stringify(event))).toBe(name === "contact.created" ? 254 : 362);
    expect(contactsCapabilities.events[name].schema.safeParse({ firstName: "Private" }).success).toBe(false);
  }
  expect(contactsCapabilities.types.contact.reader).toBe("contact.read");
  expect(contactsCapabilities.types.book.reader).toBe("book.read");
  for (const changed of [[], ["firstName"], Array(11).fill("profile")])
    expect(contactsCapabilities.events["contact.updated"].schema.safeParse({ changed }).success).toBe(false);
});

test("tag changes and note creation gain shared policies without changing delete or move", () => {
  const manifest = compileCapabilityManifest("contacts", contactsCapabilities);
  for (const name of ["tag.change", "note.create"]) expect(manifest.policies?.[name]).toEqual({ silent: "shared" });
  for (const name of ["contact.delete", "contact.move"]) expect(manifest.policies?.[name]).toBeUndefined();
});
