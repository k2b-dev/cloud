import { Hono } from "hono";
import { defineApp } from "../_internal/define-app";
import { person } from "../_internal/define-app.test-fixture";
import type { RuntimeAppMeta } from "../contracts/app";
import type { User } from "../contracts/shared";
import { type AuthContext, auth } from "../server/middleware/auth";
import Layout from "./Layout";
import PanelLayout from "./PanelLayout";
import Column from "./page-swap-fixture/Column.island";
import ProviderProbe from "./page-swap-fixture/ProviderProbe.island";
import type { RuntimeContext } from "./runtime";

const probe = defineApp({
  id: "fixture",
  name: "Fixture",
  icon: "ti ti-box",
  description: "Page swap browser fixture",
  baseUrl: "http://fixture:3000",
  routes: ["/app/fixture"],
  pageSwap: true,
});
const apps: RuntimeAppMeta[] = [
  {
    id: "fixture",
    name: "Fixture",
    icon: "ti ti-box",
    description: "Fixture",
    routes: ["/app/fixture"],
    nav: { href: "/app/fixture", section: "primary" },
  },
  {
    id: "core",
    name: "Provider",
    icon: "ti ti-box",
    description: "Provider",
    routes: ["/app/provider"],
    panel: { href: "/app/provider/panel", label: "Provider", icon: "ti ti-box" },
  },
  {
    id: "other",
    name: "Other",
    icon: "ti ti-box",
    description: "Other",
    routes: ["/app/other"],
    nav: { href: "/app/other", section: "primary" },
  },
];
// The route policy decides alone; these pages never render their content for the fixture person.
const policies = new Hono<AuthContext>()
  .get("/protected-login", auth.requireRole("user", probe.ssr.access), ...probe.ssr(() => () => <p>Unreachable</p>))
  .get("/forbidden", auth.requireRole("admin", probe.ssr.access), ...probe.ssr(() => () => <p>Unreachable</p>))
  .get("/revoked", auth.requireRole("admin", probe.ssr.access), ...probe.ssr(() => () => <p>Unreachable</p>));
export type FixtureEnvironment = { Variables: AuthContext["Variables"] & { runtime: RuntimeContext } };
export const server = new Hono<FixtureEnvironment>()
  .use(async (c, next) => {
    c.set("runtime", { apps });
    if (!c.req.path.endsWith("/protected-login")) {
      const id = c.req.header("cookie")?.match(/(?:^|;\s*)fixture_person=([^;]+)/)?.[1];
      const user: User = { ...person, ...(id ? { id } : {}) };
      c.set("user", user);
    }
    await next();
  })
  .get(
    "/app/provider/panel",
    ...probe.ssr<FixtureEnvironment>((c) => () => (
      <PanelLayout c={c} title="Provider">
        <label>
          Draft
          <textarea aria-label="Provider draft" />
        </label>
        <output id="provider-context" />
        <output id="pending-result" />
        <ProviderProbe />
      </PanelLayout>
    )),
  )
  .get("/app/fixture/file", (c) => c.body("Fixture file", 200, { "content-type": "text/plain" }))
  .get("/api/fixture", (c) => c.json({ fixture: true }))
  .get("/app/fixture/download", (c) =>
    c.body("Download", 200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="fixture.txt"' }),
  )
  .route("/app/fixture", policies)
  .get(
    "/auth/login",
    ...probe.ssr<FixtureEnvironment>((c) => () => (
      <Layout c={c} title="Sign in" panel={false}>
        <h1>Sign in to continue</h1>
      </Layout>
    )),
  )
  .get(
    "/app/other",
    ...probe.ssr<FixtureEnvironment>((c) => () => (
      <Layout c={c} title="Other">
        <h1>Other app</h1>
      </Layout>
    )),
  )
  .get(
    "/app/fixture/:page?",
    ...probe.ssr<FixtureEnvironment>((c) => {
      const page = c.req.param("page") ?? "A";
      const label =
        page === "B"
          ? "Full page B"
          : page === "focus"
            ? "Focus editor"
            : page === "order"
              ? "Order probe"
              : page === "C"
                ? "Regular page C"
                : "Regular page A";
      return () => (
        <Layout
          c={c}
          title={page === "A" ? label : [{ title: "Regular page A", href: "/app/fixture/A" }, { title: label }]}
          fullPage={page === "B"}
          fullWidth={page === "B"}
          focusMode={page === "focus"}
          help={[`help-${page.toLowerCase()}`]}
          context={{ scope: { type: "fixture.page", id: page } }}
        >
          <h1>{label}</h1>
          <Column page={page} historyProbe={page === "order"} />
          <a id="to-A" href="/app/fixture/A">
            A
          </a>
          <a id="to-B" href="/app/fixture/B">
            B
          </a>
          <a id="to-C" href="/app/fixture/C">
            C
          </a>
          <a id="to-order" href="/app/fixture/order">
            Order
          </a>
          <a id="to-focus" href="/app/fixture/focus">
            Focus
          </a>
          <a id="to-other" href="/app/other">
            Other app
          </a>
          <a id="to-api" href="/api/fixture">
            API
          </a>
          <a id="to-file" href="/app/fixture/file">
            File
          </a>
          <a id="to-download" href="/app/fixture/download" download="">
            Download
          </a>
          <a id="to-protected-login" href="/app/fixture/protected-login">
            Sign-in policy
          </a>
          <a id="to-forbidden" href="/app/fixture/forbidden">
            Forbidden policy
          </a>
          <a id="to-revoked" href="/app/fixture/revoked">
            Revoked access
          </a>
          <form action="/app/fixture/A" method="get">
            <input name="query" value="submitted" />
            <button id="submit" type="submit">
              Submit
            </button>
          </form>
          <div style="height:1600px" />
          <ul>
            <li id="row-B">
              <a href="/app/fixture/B">B row</a>
            </li>
          </ul>
        </Layout>
      );
    }),
  );
