// Measures a dashboard widget handler against the test Postgres: the data a widget budget is derived from. A timing
// test calls `timeWidgetHandler` once per widget; the CI log then holds one line per widget:
//   widget-timing <app>/<widget> size=<size> calls=20 p50=<ms> p95=<ms> max=<ms>
import { expect } from "bun:test";
import { type Context, Hono } from "hono";
import type { DashboardWidgetSize, User, WidgetSettingsDeclaration } from "../../packages/cloud/src/contracts";
import { sql } from "../../packages/cloud/src/runtime/clients";
import type { AuthContext } from "../../packages/cloud/src/server";
import { setWidgetRequest } from "../../packages/cloud/src/server/widget-request";

/** As many calls as the budget decision asked for: 20 per widget, the first (cold) one included. */
export const WIDGET_TIMING_CALLS = 20;

/** A person in `auth.users` for the handler to read their own data; `admin` for widgets only administrators see. */
export const timingUser = async (options: { admin?: boolean } = {}): Promise<User> => {
  const uid = `widget-timing-${crypto.randomUUID().slice(0, 8)}`;
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
    VALUES (${uid}, 'local', 'user', 'Widget timing') RETURNING id`;
  return {
    id: row!.id,
    uid,
    provider: "local",
    profile: "user",
    roles: options.admin ? ["user", "admin"] : ["user"],
    givenname: "Widget",
    sn: "Timing",
    displayName: "Widget Timing",
    mail: null,
    avatarHash: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
    ipa: null,
  };
};

const percentile = (sorted: readonly number[], share: number) => sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)]!;

/**
 * Calls `handler` as the framework's widget route does (the person as actor, the size asked for, the declared settings)
 * `WIDGET_TIMING_CALLS` times in a row, expects an answer each time, and prints the times.
 */
export const timeWidgetHandler = async (options: {
  /** `<appId>/<widgetId>`. */
  key: string;
  user: User;
  size: DashboardWidgetSize;
  settings?: WidgetSettingsDeclaration;
  handler: (c: Context<AuthContext>) => Response | Promise<Response>;
}) => {
  const app = new Hono<AuthContext>()
    .use(async (c, next) => {
      c.set("actor", { kind: "user", user: options.user });
      c.set("accessSubject", { type: "user", userId: options.user.id });
      c.set("user", options.user);
      c.set("credentialKind", "session");
      c.set("credentialScopes", []);
      setWidgetRequest(c, { sizes: [options.size], defaultSize: options.size, settings: options.settings });
      await next();
    })
    .get("/", (c) => options.handler(c));
  const times: number[] = [];
  for (let call = 0; call < WIDGET_TIMING_CALLS; call++) {
    const started = performance.now();
    const response = await app.request(`/?size=${options.size}`, { headers: { "accept-language": "de" } });
    await response.arrayBuffer();
    times.push(performance.now() - started);
    expect([200, 204]).toContain(response.status);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const stats = { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1)! };
  console.log(
    `widget-timing ${options.key} size=${options.size} calls=${WIDGET_TIMING_CALLS} p50=${stats.p50.toFixed(1)} p95=${stats.p95.toFixed(1)} max=${stats.max.toFixed(1)}`,
  );
  return stats;
};
