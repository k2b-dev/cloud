import { expect, test } from "bun:test";
import { commandPath, readCommand } from "@k2b/cloud/contracts";
import { mailCalendarCommandHref } from "./mail-calendar-command";

test("calendar entry preserves the exact existing draft and return view, rejecting invalid links", () => {
  const options = { returnTo: "/app/spaces/Space1?item=Event1" };
  const input = { mailboxId: "Box001", draftId: "Draft1" };
  const entry = commandPath("/app/mail/calendar", "mail.draft.calendar", input, options);
  const href = mailCalendarCommandHref(new URL(entry, "https://cloud.example"));
  expect(href).not.toBeNull();
  const resolved = new URL(href!, "https://cloud.example");
  expect(resolved.pathname).toBe("/app/mail/Box001/compose/Draft1");
  expect(resolved.searchParams.get("return")).toBe(options.returnTo);
  expect(readCommand(resolved)).toMatchObject({ id: "mail.draft.calendar", input, options });
  for (const invalid of [
    "/app/mail/calendar",
    commandPath("/app/mail/calendar", "mail.compose", {}),
    commandPath("/app/mail/calendar", "mail.draft.calendar", { ...input, draftId: "../bad" }),
    commandPath("/app/mail/calendar", "mail.draft.calendar", { ...input, body: "private" }),
  ])
    expect(mailCalendarCommandHref(new URL(invalid, "https://cloud.example"))).toBeNull();
});
