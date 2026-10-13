import { expect, test } from "bun:test";
import { assertResourceOpenLink } from "./testing";

test("validates the first top-level open destination", () => {
  const open = { rel: "open" as const, href: "/app/mail/MbA123/compose/DrG789" };
  expect(assertResourceOpenLink({ links: [{ rel: "download", href: "/api/download" }, open] })).toEqual(open);
  expect(() => assertResourceOpenLink({})).toThrow("top-level open link");
  expect(() => assertResourceOpenLink({ links: [{ rel: "edit", href: open.href }] })).toThrow("top-level open link");
  for (const href of ["https://example.test/app", "//example.test/app", "/" + "x".repeat(2048)]) {
    expect(() => assertResourceOpenLink({ links: [{ rel: "open", href }] })).toThrow();
  }
});
