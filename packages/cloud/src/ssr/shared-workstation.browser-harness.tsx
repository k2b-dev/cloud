import { Hono } from "hono";
import { defineApp } from "../_internal/define-app";
import { person } from "../_internal/define-app.test-fixture";
import type { User } from "../contracts/shared";
import type { SessionIdle } from "../services/session";
import Layout from "./Layout";
import type { RuntimeContext } from "./runtime";

const desk = defineApp({
  id: "shared-desk-probe",
  name: "Counter",
  icon: "ti ti-building-store",
  description: "Shared workstation browser fixture",
  baseUrl: "http://shared-desk-probe:3000",
  routes: ["/app/desk"],
});

export const TIMEOUT_SECONDS = 600;

/** The server's single idle clock, as the activity route keeps it; the test sets `now` and reads what reached it. */
export const serverState = { lastInput: 0, reports: 0, reads: 0, now: () => 0 };
const remaining = () => Math.max(0, Math.round(TIMEOUT_SECONDS - (serverState.now() - serverState.lastInput) / 1_000));
const state = () => ({ sharedWorkstation: true, idle: { remainingSeconds: remaining(), timeoutSeconds: TIMEOUT_SECONDS } });

type Environment = { Variables: { runtime: RuntimeContext; user: User; sessionIdle: SessionIdle } };
export const server = new Hono<Environment>()
  .use("/app/*", async (c, next) => {
    c.set("runtime", {
      apps: [
        {
          id: "shared-desk-probe",
          name: "Counter",
          description: "Shared workstation browser fixture",
          icon: "ti ti-building-store",
          routes: ["/app/desk"],
          nav: { href: "/app/desk", section: "primary" },
        },
      ],
    });
    c.set("user", person);
    c.set("sessionIdle", { remainingSeconds: remaining(), timeoutSeconds: TIMEOUT_SECONDS });
    await next();
  })
  .get(
    "/app/desk",
    ...desk.ssr<Environment>((c) => () => (
      <Layout c={c} title={[{ title: "Counter", href: "/app/desk" }, { title: "Orders" }]}>
        <section class="flex flex-col gap-3 p-6">
          <h1 class="text-xl font-semibold">Orders at the counter</h1>
          <p>Order 1042 · Table 7 · 2 × espresso, 1 × croissant</p>
          <textarea aria-label="Note" class="h-24 w-full max-w-md rounded border p-2" />
        </section>
      </Layout>
    )),
  )
  .get("/api/me/browser", (c) => {
    serverState.reads++;
    return c.json(state());
  })
  .post("/api/me/browser/activity", (c) => {
    serverState.reports++;
    serverState.lastInput = serverState.now();
    return c.json(state());
  })
  .post("/api/background", (c) => c.json({ ok: true }))
  .get("/auth/login", (c) => c.html("<!doctype html><title>Sign in</title><main>Signed out</main>"));
