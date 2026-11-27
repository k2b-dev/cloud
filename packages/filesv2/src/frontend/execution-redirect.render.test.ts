import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { session } from "@k2b/cloud/services";
import { type Context, type Env, type Handler, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { testActor } from "../../test/files-call";
import { current, entry, hidden } from "../../test/history-fixtures";
import type { ActivityEntry } from "../activity-contracts";
import { FilesError } from "../service/errors";
import { runHref } from "./execution-url";
import { readRun } from "./run-read";

await import("../../test/solid-ssr-preload");

// Keep the mounted Files router, real role middleware, loader and detail rendering.
// Replace only the platform rendering adapter/chrome and unrelated Files pages.
function renderPage<E extends Env>(load: (c: Context<E>) => Promise<Response | (() => JSX.Element)>) {
  const handler: Handler<E> = async (c) => {
    const loaded = await load(c);
    if (loaded instanceof Response) return loaded;
    c.header("Cache-Control", "private, no-store");
    return c.html(renderToString(loaded));
  };
  return [handler] as const;
}
const pageSsr = Object.assign(renderPage, {
  access: {
    onReject: (c: Context, reason: string) => (reason === "unauthenticated" ? c.redirect("/login") : c.html("Forbidden", 403)),
  },
  error: (
    c: Context,
    status: ContentfulStatusCode,
    copy?: { title: string; description: string; action: { label: string; href: string } },
  ) => {
    c.header("Cache-Control", "private, no-store");
    return c.html(
      copy
        ? `<main><h1>${copy.title}</h1><p>${copy.description}</p><a href="${copy.action.href}">${copy.action.label}</a></main>`
        : "<main>Unavailable</main>",
      status,
    );
  },
});
mock.module("../config", () => ({ ssr: pageSsr }));
const unused: Handler = (c) => c.text("Unrelated page");
mock.module("./page", () => ({ default: [unused] }));
mock.module("./admin", () => ({ default: [unused] }));
mock.module("./pdf-page", () => ({ pdfPage: new Hono() }));
mock.module("./public-pages", () => ({ publicSharePage: [unused], publicInboxPage: [unused] }));

const id = "30000000-0000-4000-8000-000000000003";
const record = () =>
  entry({
    id,
    action: "item.move",
    via: "agent",
    before: current("team/Old/Report.pdf"),
    after: current("team/New/Report.pdf"),
    actor: { kind: "user", userId: "20000000-0000-4000-8000-000000000002", name: "Another actor" },
    execution: { requestId: "request-reference", invocationId: "invocation-reference", origin: "assistant", callingApp: "core" },
  });
const read = mock(async (): Promise<ActivityEntry> => record());
mock.module("../service", () => ({ FilesError, filesService: { activityEntry: read } }));
const { default: routes } = await import("./index");
const request = (path = `/app/filesv2/execution/${id}`, token = "user") =>
  routes.request(path, { headers: { cookie: `session_token=${token}` } });
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  read.mockReset();
  read.mockImplementation(async () => record());
  if (testActor.kind !== "user") throw new Error("Expected a user fixture");
  const user = testActor.user;
  spies.push(
    spyOn(session, "authenticateRequest").mockImplementation(async (_c, token) =>
      token === "expired"
        ? null
        : { user, data: { userId: user.id, sid: "fixture", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" } },
    ),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

// The execution page (v1) became the run beside Activity's list (27.11.2026): its address leads there.
describe("the former execution page", () => {
  test("leads to the run beside Activity, without reading the record itself", async () => {
    const response = await request();
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(`/app/filesv2?view=activity&run=${id}`);
    expect(read).not.toHaveBeenCalled();
  });
  test("expired credentials sign in first", async () => {
    expect((await request(undefined, "expired")).status).toBe(302);
  });
  test("an invalid activity UUID is opaque and leads nowhere", async () => {
    const response = await request("/app/filesv2/execution/request-reference");
    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
  });
});

// The run's read on the server, with the reader's current rights, at every load of the page.
describe("the run beside Activity on the server", () => {
  test("another actor's authorized run is read with the reader's rights", async () => {
    expect(await readRun(id, read)).toEqual({ id, entry: record() });
  });
  test.each([403, 404] as const)("a refusal %s says only that the run is not there", async (status) => {
    const run = await readRun(id, async () => {
      throw new FilesError("secret-path-and-context", status);
    });
    expect(run).toEqual({ id, problem: "missing" });
    expect(JSON.stringify(run)).not.toContain("secret");
  });
  test.each([500, 503] as const)("a failure %s offers to read it again", async (status) => {
    expect(
      await readRun(id, async () => {
        throw new FilesError("unavailable", status);
      }),
    ).toEqual({ id, problem: "failed" });
  });
  test("an ordinary request has no run link and no run", async () => {
    const ordinary: ActivityEntry = {
      ...record(),
      via: "web",
      execution: { requestId: "ordinary-request", invocationId: null, origin: null, callingApp: null },
    };
    expect(runHref({})(ordinary)).toBeNull();
    expect(await readRun(id, async () => ordinary)).toEqual({ id, problem: "missing" });
  });
  test("a projection stripped of its run cannot show stale details", async () => {
    const { execution: _removed, ...limited } = record();
    expect(await readRun(id, async () => ({ ...limited, before: hidden, after: hidden }))).toEqual({ id, problem: "missing" });
  });
  test("a run link keeps Activity's filters", () => {
    expect(runHref({ actor: "me" })(record())).toBe(`/app/filesv2?view=activity&who=me&run=${id}`);
  });
});
