import { expect, test } from "bun:test";
import { syncNatsFilterHref } from "./sync-nats-filters";

test("changing filters preserves scope but clears stale selection and pagination", () => {
  const href = syncNatsFilterHref(
    "/admin/observability/nats",
    "?app=mail&namespace=dev&resource=mail%3Ajob&problems=true&offset=50&stream=S6_OLD&consumerOffset=20&limit=20",
    { app: "core" },
  );
  const params = new URL(href, "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toEqual({ app: "core", namespace: "dev", resource: "mail:job", problems: "true", limit: "20" });
  expect(
    syncNatsFilterHref("/admin/observability/sync", "?app=mail&storeApp=mail&kind=queue&store=job&message=x&sequence=2&cursor=3", {
      app: "",
    }),
  ).toBe("/admin/observability/sync");
});
