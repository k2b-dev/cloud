import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { CapabilityExecutionContext, CapabilityQueryDefinition, CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { settings } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import apiRoutes from "./api";
import { venueCapabilities } from "./capabilities";
import type { PublicStatus, VenueDashboard } from "./contracts";
import "./frontend/ssr-test-plugin";

const { default: pageRoutes } = await import("./frontend");

const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(30_000);

const venueApp = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/api/venue", apiRoutes)
  .route("/app/venue", pageRoutes);

type Caller = { cookie?: string; authorization?: string };

const send = (method: "GET" | "POST" | "PATCH", path: string, caller: Caller, body?: unknown) =>
  venueApp.request(path, {
    method,
    headers: {
      ...caller,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-forwarded-for": uniqueCallerAddress(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const expectStatus = async (response: Response, status: number, label: string): Promise<string> => {
  const text = await response.text();
  expect({ label, status: response.status, body: response.status === status ? "" : text.slice(0, 2_000) }).toEqual({
    label,
    status,
    body: "",
  });
  return text;
};

const insertUser = async (label: string): Promise<User> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`venue-${label}-${suffix}`}, 'local', 'user', ${`Venue ${label}`}, ${`venue-${label}-${suffix}@example.test`})
    RETURNING id
  `;
  return {
    id: row!.id,
    uid: `venue-${label}-${suffix}`,
    roles: ["user", "local", "local/user"],
    provider: "local",
    profile: "user",
    givenname: "Venue",
    sn: label,
    displayName: `Venue ${label}`,
    mail: `venue-${label}-${suffix}@example.test`,
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

const capabilityContext = (actor: CapabilityExecutionContext["actor"], user: User | null): CapabilityExecutionContext => ({
  actor,
  accessSubject:
    actor.kind === "service_account"
      ? { type: "service_account", serviceAccountId: actor.serviceAccount.id }
      : { type: "user", userId: user!.id },
  user,
  locale: "en",
  requestId: "req-test",
  origin: "app",
  signal: new AbortController().signal,
});

const userContext = (user: User) => capabilityContext({ kind: "user", user }, user);

/** The capability context of a Venue API key, as Core resolves it from the key's resource-bound service account. */
const apiKeyContext = async (venueId: string, name: string, scope: "read" | "write"): Promise<CapabilityExecutionContext> => {
  const [account] = await sql<{ id: string; created_at: string }[]>`
    SELECT sa.id::text, sa.created_at::text
    FROM auth.service_accounts sa
    JOIN venue.venues v ON v.id::text = sa.resource_id
    WHERE sa.app_id = 'venue' AND v.short_id = ${venueId} AND sa.name LIKE ${`%API key: ${name}`}
  `;
  if (!account) throw new Error(`Missing API key service account ${name}`);
  const [venue] = await sql<{ id: string }[]>`SELECT id::text FROM venue.venues WHERE short_id = ${venueId}`;
  return capabilityContext(
    {
      kind: "service_account",
      serviceAccount: {
        id: account.id,
        name,
        kind: "resource_bound",
        status: "active",
        delegatedUserId: null,
        appId: "venue",
        resourceType: "venue",
        resourceId: venue!.id,
        createdBy: null,
        createdAt: account.created_at,
      },
      delegatedUser: null,
      scopes: [scope],
    },
    null,
  );
};

const feedbackSummary = (venueId: string, context: CapabilityExecutionContext) => {
  const operation = (venueCapabilities.queries as unknown as Readonly<Record<string, CapabilityQueryDefinition>>)["feedback.summary"]!;
  return Promise.resolve(operation.run(operation.input.parse({ venueId }), context));
};

suite("Venue feedback and hidden sections", () => {
  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
  });

  test("readers see what the public page shows; staff, admins, and write keys also see feedback and hidden sections", async () => {
    const admin = await insertUser("admin");
    const staff = await insertUser("staff");
    const reader = await insertUser("reader");
    const owner = { cookie: `session_token=${await createTestSession(admin.id)}` };
    const slug = `harbor-cafe-${admin.id.slice(0, 8)}`;
    const comment = "The espresso machine was broken again";
    const draftTitle = "Draft: winter hours";

    try {
      const created = await send("POST", "/api/venue/venues", owner, { name: "Harbor Cafe", slug });
      const createdText = await expectStatus(created, 201, "create venue");
      const venueId = (JSON.parse(createdText) as { id: string }).id;
      const createSection = async (title: string, enabled: boolean) => {
        const response = await send("POST", `/api/venue/venues/${venueId}/sections`, owner, {
          kind: "notice",
          title,
          content: { text: `${title} text` },
          enabled,
        });
        return (JSON.parse(await expectStatus(response, 201, `create section ${title}`)) as { id: string }).id;
      };
      const publicSectionId = await createSection("Opening week", true);
      const draftSectionId = await createSection(draftTitle, false);
      for (const [user, permission] of [
        [staff, "write"],
        [reader, "read"],
      ] as const) {
        const grant = await send("POST", `/api/venue/venues/${venueId}/access`, owner, {
          principal: { type: "user", userId: user.id },
          permission,
        });
        await expectStatus(grant, 201, `grant ${permission}`);
      }
      const createKey = async (name: string, permission: "read" | "write") => {
        const response = await send("POST", `/api/venue/venues/${venueId}/api-keys`, owner, { name, permission });
        return { authorization: `Bearer ${(JSON.parse(await expectStatus(response, 201, `create ${name}`)) as { token: string }).token}` };
      };
      const feedback = await send("POST", `/api/venue/public/${venueId}/feedback`, {}, { rating: 2, comment });
      await expectStatus(feedback, 201, "submit anonymous feedback");

      const publicStatus = JSON.parse(
        await expectStatus(await send("GET", `/api/venue/public/${venueId}/status`, {}), 200, "public status"),
      ) as PublicStatus;
      expect(publicStatus.sections.map((section) => section.id)).toEqual([publicSectionId]);

      // Each caller's HTTP credentials and the capability context Core would resolve for the same principal.
      const callers = {
        admin: { caller: owner, context: userContext(admin), internal: true },
        staff: { caller: { cookie: `session_token=${await createTestSession(staff.id)}` }, context: userContext(staff), internal: true },
        reader: {
          caller: { cookie: `session_token=${await createTestSession(reader.id)}` },
          context: userContext(reader),
          internal: false,
        },
        "write key": {
          caller: await createKey("Counter tablet", "write"),
          context: await apiKeyContext(venueId, "Counter tablet", "write"),
          internal: true,
        },
        "read key": {
          caller: await createKey("Lobby display", "read"),
          context: await apiKeyContext(venueId, "Lobby display", "read"),
          internal: false,
        },
      };

      // No caller gets a venue-wide calendar token: calendar links are personal (`/api/venue/calendar/my`).
      expect(createdText).not.toMatch(/ical_?token/i);
      for (const [name, { caller }] of Object.entries(callers)) {
        // API keys use the API only; people also get the workspace page.
        const paths = ["/api/venue/venues", `/api/venue/venues/${venueId}/dashboard`];
        if (!name.endsWith("key")) paths.push(`/app/venue/${venueId}/shifts`);
        for (const path of paths) {
          const text = await expectStatus(await send("GET", path, caller), 200, `${name} GET ${path}`);
          expect({ name, path, token: /ical_?token/i.test(text) }).toEqual({ name, path, token: false });
        }
      }

      // API and CLI: `cld venue get` and `cld venue sections list` print this dashboard.
      for (const [name, { caller, internal }] of Object.entries(callers)) {
        for (const query of ["", "?includeFeedbackEntries=true&feedbackDays=30"]) {
          const label = `${name} GET dashboard${query}`;
          const text = await expectStatus(await send("GET", `/api/venue/venues/${venueId}/dashboard${query}`, caller), 200, label);
          const dashboard = JSON.parse(text) as VenueDashboard;
          if (internal) {
            expect({ label, count: dashboard.feedback?.count }).toEqual({ label, count: 1 });
            expect({ label, sections: dashboard.sections.map((section) => section.id) }).toEqual({
              label,
              sections: [publicSectionId, draftSectionId],
            });
            if (query)
              expect({ label, comments: dashboard.feedbackEntries.map((entry) => entry.comment) }).toEqual({ label, comments: [comment] });
          } else {
            expect({ label, feedback: dashboard.feedback, entries: dashboard.feedbackEntries }).toEqual({
              label,
              feedback: null,
              entries: [],
            });
            expect({ label, sections: dashboard.sections }).toEqual({ label, sections: publicStatus.sections });
            expect({ label, leaks: [comment, draftTitle].filter((value) => text.includes(value)) }).toEqual({ label, leaks: [] });
          }
        }
      }

      // SSR: readers reach neither feedback nor drafts, and a direct URL returns them to the schedule. Only admins open the Public page view, where drafts are listed;
      // old section links lead admins there with the section marked and everyone else to the schedule.
      const feedbackHref = `/app/venue/${venueId}/feedback`;
      const scheduleHref = `/app/venue/${venueId}/shifts`;
      const publicViewHref = `/app/venue/${venueId}/public`;
      for (const name of ["admin", "staff", "reader"] as const) {
        const { caller, internal } = callers[name];
        const schedule = await expectStatus(await send("GET", scheduleHref, caller), 200, `${name} schedule page`);
        expect({
          name,
          feedbackLink: schedule.includes(`href="${feedbackHref}"`),
          publicView: schedule.includes(`href="${publicViewHref}"`),
        }).toEqual({ name, feedbackLink: internal, publicView: name === "admin" });
        // The page carries the caller's workspace data: drafts only for staff and admins.
        expect({ name, draft: schedule.includes(draftTitle) }).toEqual({ name, draft: internal });
        expect(schedule).not.toContain(comment);

        const feedbackPage = await send("GET", feedbackHref, caller);
        if (internal) expect(await expectStatus(feedbackPage, 200, `${name} feedback page`)).toContain(comment);
        else
          expect({ status: feedbackPage.status, location: feedbackPage.headers.get("location") }).toEqual({
            status: 302,
            location: scheduleHref,
          });

        const publicView = await send("GET", publicViewHref, caller);
        if (name === "admin") {
          const html = await expectStatus(publicView, 200, "admin public page view");
          expect(html).toContain(draftTitle);
          expect(html).toContain('data-public-layout="preview"');
          expect(html).toContain("Opening week text");
        } else {
          expect({ name, status: publicView.status, location: publicView.headers.get("location") }).toEqual({
            name,
            status: 302,
            location: scheduleHref,
          });
        }

        for (const sectionId of [draftSectionId, publicSectionId]) {
          const old = await send("GET", `/app/venue/${venueId}/public-sections/${sectionId}`, caller);
          expect({ name, status: old.status, location: old.headers.get("location") }).toEqual({
            name,
            status: 302,
            location: name === "admin" ? `${publicViewHref}?section=${sectionId}` : scheduleHref,
          });
        }
      }

      // Capabilities: the aggregate summary follows the same rule as the dashboard.
      for (const [name, { context, internal }] of Object.entries(callers)) {
        const result = await feedbackSummary(venueId, context);
        const outcome = result.ok ? { count: result.data.data.count } : { code: result.error.code, status: result.error.status };
        expect({ name, outcome }).toEqual({ name, outcome: internal ? { count: 1 } : { code: "FORBIDDEN", status: 403 } });
      }

      // With the public page switched off, readers see no sections at all, like visitors.
      const update = await send("PATCH", `/api/venue/venues/${venueId}`, owner, { name: "Harbor Cafe", slug, publicEnabled: false });
      await expectStatus(update, 200, "switch the public page off");
      for (const [name, { caller, internal }] of Object.entries(callers)) {
        const text = await expectStatus(
          await send("GET", `/api/venue/venues/${venueId}/dashboard`, caller),
          200,
          `${name} private dashboard`,
        );
        expect({ name, sections: (JSON.parse(text) as VenueDashboard).sections.length }).toEqual({ name, sections: internal ? 2 : 0 });
      }
    } finally {
      const owned = await sql<{ id: string }[]>`
        SELECT va.venue_id::text AS id FROM venue.venue_access va JOIN auth.access a ON a.id = va.access_id WHERE a.user_id = ${admin.id}::uuid
      `;
      for (const { id } of owned) {
        await sql`DELETE FROM auth.service_accounts WHERE app_id = 'venue' AND resource_id = ${id}`;
        await sql`DELETE FROM venue.venues WHERE id = ${id}::uuid`;
      }
      for (const user of [admin, staff, reader]) await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
    }
  });
});
