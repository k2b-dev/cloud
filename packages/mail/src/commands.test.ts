import { MailDraftCalendarInputSchema } from "./commands";
import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { MailComposeCommandInputSchema } from "./commands";

test("Mail Command is discoverable empty and carries only a contact reference", () => {
  const manifest = compileCapabilityManifest("mail", {
    protocolVersion: 2,
    commands: {
      compose: { title: "Compose", description: "Open Mail.", input: MailComposeCommandInputSchema, path: "/app/mail/compose" },
    },
  });
  expect(manifest.commands).toHaveLength(1);
  expect(MailComposeCommandInputSchema.parse({})).toEqual({});
  expect(MailComposeCommandInputSchema.safeParse({ contact: { type: "contacts.contact", id: "AbCd12" } }).success).toBe(true);
  expect(MailComposeCommandInputSchema.safeParse({ email: "a@example.test" }).success).toBe(false);
});

test("calendar Commands require an existing resource and reject arbitrary payloads", () => {
  expect(MailDraftCalendarInputSchema.safeParse({}).success).toBe(false);
  expect(MailDraftCalendarInputSchema.safeParse({ mailboxId: "Box001", draftId: "Draft1" }).success).toBe(true);
  expect(MailDraftCalendarInputSchema.safeParse({ ...{ mailboxId: "Box001", draftId: "Draft1" }, body: "private mail" }).success).toBe(
    false,
  );
});
