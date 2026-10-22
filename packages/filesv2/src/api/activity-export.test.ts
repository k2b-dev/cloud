import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { testActor, testCall } from "../../test/files-call";
import { createActivityExportService } from "../service/activity-export";
import { FilesError } from "../service/errors";
import { createActivityExportApi } from "./activity-export";

beforeEach(() => setSystemTime(new Date("2030-05-15T12:00:00.000Z")));
afterEach(() => setSystemTime());
function fixture(options: { denied?: boolean; count?: number; auditFailure?: boolean } = {}) {
  let close = 0;
  let opens = 0;
  let audits = 0;
  const service = createActivityExportService({
    async requireAdmin() {
      if (options.denied) throw new FilesError("forbidden", 403);
    },
    displayNames: async (entries) => entries,
    async snapshot() {
      opens++;
      return {
        async count() {
          return options.count ?? 0;
        },
        async batch() {
          return [];
        },
        async close() {
          close++;
        },
      };
    },
    async recordStart() {
      if (options.auditFailure) throw new Error("secret opaque error");
      audits++;
    },
  });
  const api = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", testActor);
      c.set("accessSubject", testCall(testActor).accessSubject);
      await next();
    })
    .route("/", createActivityExportApi(service));
  return {
    api,
    get close() {
      return close;
    },
    get opens() {
      return opens;
    },
    get audits() {
      return audits;
    },
  };
}
const url = "/admin/activity/export?format=csv&from=2030-01-01&to=2030-12-31";

test("route delivers a CSV attachment only after audit commit, prevents caching, and has one header for no rows", async () => {
  const f = fixture();
  const response = await f.api.request(url);
  expect(response.status).toBe(200);
  expect(f.audits).toBe(1);
  expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="files-activity.csv"');
  expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
  expect((await response.text()).split("\r\n")).toHaveLength(2);
  expect(f.close).toBe(1);
});
test("JSONL has no framing or header", async () => {
  const f = fixture();
  const response = await f.api.request(url.replace("format=csv", "format=jsonl"));
  expect(response.headers.get("Content-Type")).toBe("application/x-ndjson; charset=utf-8");
  expect(await response.text()).toBe("");
  expect(f.close).toBe(1);
});
test("denial yields no export content and opens no database reader", async () => {
  const f = fixture({ denied: true });
  const response = await f.api.request(url);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ ok: false, code: "forbidden" });
  expect(response.headers.has("Content-Disposition")).toBe(false);
  expect(f.opens).toBe(0);
});
test("overflow and calendar-year limit return stable 413 codes and the narrow-range remedy before an attachment", async () => {
  for (const [request, count, code] of [
    [url, 100001, "activity_export_limit"],
    [url.replace("to=2030-12-31", "to=2031-01-01"), 0, "activity_export_range"],
  ] as const) {
    const f = fixture({ count });
    const response = await f.api.request(request);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, code, remedy: "narrow_date_range" });
    expect(response.headers.has("Content-Disposition")).toBe(false);
    expect(f.audits).toBe(0);
  }
});
test("audit failure returns a minimal error without opaque server text or an attachment", async () => {
  const f = fixture({ auditFailure: true });
  const response = await f.api.request(url);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, code: "activity_export_failed", remedy: "retry" });
  expect(response.headers.has("Content-Disposition")).toBe(false);
  expect(f.close).toBe(1);
});
test("invalid dates, formats and unknown fields reject before reading history", async () => {
  for (const request of [url.replace("2030-01-01", "2030-02-29"), url.replace("format=csv", "format=xml"), `${url}&detail=all`]) {
    const f = fixture();
    const response = await f.api.request(request);
    expect(response.status).toBe(400);
    expect(f.opens).toBe(0);
  }
});

test("preview counts with current administration rights, closes SQL and never creates an export audit", async () => {
  const f = fixture({ count: 8412 });
  const response = await f.api.request(url.replace("export?", "export/preview?"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ count: 8412 });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(f.close).toBe(1);
  expect(f.audits).toBe(0);
});
test("preview cannot bypass administration or the export limit", async () => {
  for (const [options, status] of [
    [{ denied: true }, 403],
    [{ count: 100001 }, 413],
  ] as const) {
    const f = fixture(options);
    expect((await f.api.request(url.replace("export?", "export/preview?"))).status).toBe(status);
    expect(f.audits).toBe(0);
  }
});
