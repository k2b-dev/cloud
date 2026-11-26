import { expect, test } from "bun:test";
import { legacyNotificationsHref } from "./query";

test("addresses from before v2 lead to the same list in the v2 address; the rest stays", () => {
  const href = (search: string) => legacyNotificationsHref(new URLSearchParams(search));
  expect(href("view=registry&search=digest&apps=mail,files&status=all")).toBe(
    "/admin/observability/deliveries?tab=registry&q=digest&app=mail,files",
  );
  expect(href("view=legacy&search=willkommen&status=error&page=2")).toBe(
    "/admin/observability/deliveries?tab=legacy&q=willkommen&status=error&page=2",
  );
  expect(href("view=legacy")).toBe("/admin/observability/deliveries?tab=legacy");
  // a v2 address stays; the deliveries view is no list of this page (the router sends it to Runs)
  expect(href("tab=legacy&status=error")).toBeNull();
  expect(href("status=failed")).toBeNull();
});
