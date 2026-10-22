import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { session } from "@k2b/cloud/services";
import { LocaleProvider } from "@k2b/ui";
import { type Context, type Env, type Handler, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { testActor } from "../../test/files-call";
import { current, entry, hidden } from "../../test/history-fixtures";
import type { ActivityEntry } from "../activity-contracts";
import { FilesError } from "../service/errors";
import { executionUrl } from "./execution-url";

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
mock.module("@k2b/cloud/ssr", () => ({
  Layout: (props: { c: Context<AuthContext>; children: JSX.Element }) =>
    createComponent(LocaleProvider, {
      locale: getLocale(props.c),
      get children() {
        return props.children;
      },
    }),
}));
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
const request = (path = executionUrl(id), token = "user", locale = "en") =>
  routes.request(path, {
    headers: { cookie: `session_token=${token}`, "x-cloud-locale": locale },
  });
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  read.mockReset();
  read.mockImplementation(async () => record());
  if (testActor.kind !== "user") throw new Error("Expected a user fixture");
  const user = testActor.user;
  const guest: typeof user = { ...user, profile: "guest", roles: ["guest"] };
  spies.push(
    spyOn(session, "authenticateRequest").mockImplementation(async (_c, token) =>
      token === "expired"
        ? null
        : {
            user: token === "guest" ? guest : user,
            data: { userId: user.id, sid: "fixture", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" },
          },
    ),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("Files execution page guards and SSR", () => {
  test("expired and guest credentials stop before the activity reader", async () => {
    expect((await request(undefined, "expired")).status).toBe(302);
    expect((await request(undefined, "guest")).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
  test("an invalid activity UUID is opaque and never reaches the reader", async () => {
    expect((await request("/app/filesv2/execution/request-reference")).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
  test("another actor's authorized Files effect renders and reload reauthorizes it", async () => {
    const response = await request(undefined, "user", "de");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, no-transform");
    const html = await response.text();
    expect(html).toContain("Ausführung in Dateien");
    expect(html).toContain("Another actor");
    expect(html).toContain("im Auftrag von");
    expect(html).toContain("team/Old/Report.pdf");
    expect(html).toContain("team/New/Report.pdf");
    expect(html).toContain("Quellkonversation ist über diesen Eintrag nicht verfügbar");
    expect(html).not.toContain("/app/assistant");
    expect(html).not.toContain("/admin/");
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        accessSubject: { type: "user", userId: testActor.kind === "user" ? testActor.user.id : "" },
        requestAbort: expect.any(AbortSignal),
      }),
      { activityId: id },
    );
    await request();
    expect(read).toHaveBeenCalledTimes(2);
  });
  test.each([403, 404] as const)("service %s reveals no stored data or error details", async (status) => {
    read.mockImplementation(async () => {
      throw new FilesError("secret-path-and-context", status);
    });
    const response = await request();
    expect(response.status).toBe(status);
    const html = await response.text();
    for (const value of ["Another actor", "Report.pdf", "request-reference", "secret-path-and-context"]) expect(html).not.toContain(value);
  });
  test("a projection stripped of execution context cannot open stale details", async () => {
    read.mockImplementation(async () => {
      const { execution: _removed, ...limited } = record();
      return { ...limited, before: hidden, after: hidden };
    });
    const response = await request();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Another actor");
  });
  test.each([500, 503] as const)("server %s offers one safe read retry, which reauthorizes the same record", async (status) => {
    read.mockImplementationOnce(async () => {
      throw new FilesError("unavailable", status);
    });
    const response = await request();
    expect(response.status).toBe(status);
    const html = await response.text();
    expect(html).toContain("could not be loaded");
    expect(html).toContain(`href="${executionUrl(id)}"`);
    expect(html).toContain("Try again");
    expect(html).not.toContain("request-reference");
    expect((await request()).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
