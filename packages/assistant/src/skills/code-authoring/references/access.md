# Access and secrets

Code never gets more access than its account has. A version, a check, a
handle or a setting that names a resource grants nothing.

## Who the Code runs as

| Owner | Runs as | Who switches it on | Notes |
| --- | --- | --- | --- |
| Personal | Its person, with their current access | Only that person, in a browser session | Its non-public routes open for every signed-in person; handlers restrict visitors with `c.user`. Can use `core.ai.chat.*` in the owner's own chats. |
| Mailbox | The mailbox's service account | A person with **Manage** access to the mailbox, or a Cloud administrator | Can subscribe to `mail.message.received`. |
| App | The app's service account | A Cloud administrator | Created and managed in Administration › Code. |

A service account has no sign-in, no API key and a copyable **handle** such
as `code-7k2q9m4xwt`, shown on the Code page. A resource's manager gives it
access with **Add service account** in that resource's share dialog,
**View** or **Edit**. Groups, "all signed-in people" and public links give a
service account nothing; **Manage** is refused. The share survives new
versions and pauses and changes only through normal sharing.

Tell the person after submitting which resources the service account needs
and at which level, for example: "Give `code-…` **Edit** access to the mailbox
and to the Space *Orders*." Do not change access yourself.

Phone sessions, API keys, service accounts and Code itself cannot switch Code
on. A version that uses AI, internet requests or silent Actions visible to
others first needs a Cloud administrator's approval under the default policy.

## The visitor of a page: `c.user`

Routes need a signed-in person by default, including signed-in guests.
`c.user` contains only the visitor's own identity:

| Field | Meaning |
| --- | --- |
| `id` | Cloud user ID |
| `username` | Cloud login handle, separate from the user ID |
| `groupIds` | Effective Cloud group IDs |
| `groupNames` | Effective group names |
| `kind` | Cloud account profile: `"user"` or `"guest"` |
| `name` | Display name |

Agents and other service accounts cannot visit private pages; they do not
become `c.user`. This rule is the same for personal, resource and app Code.

Use this identity to decide what a page shows or
which form it accepts. It is never data authority: every SDK call runs with
the Code's account, not the visitor's access. A page therefore must not show
mailbox data to a visitor who should not see it.

<!-- check: resource mail.mailbox -->
```tsx
import { app, jsx, owner, Page, Notice, Stats, Stat } from "@sdk";

// Fictional group ID of the team that may see this page.
const TEAM = "00000000-0000-4000-8000-0000000000aa";

app.use(async (c, next) => {
  if (c.user?.kind !== "user" || !c.user.groupIds.includes(TEAM))
    return c.json({ error: "forbidden" }, 403);
  return next();
});
app.get("/", async c => {
  const { data: open, page } = await owner.conversation.list({ view: "needs_action", limit: 50 });
  return c.page(
    <Page title="Team inbox" subtitle={`Signed in as ${c.user?.name ?? "visitor"}`}>
      <Stats>
        <Stat label="Needs action" value={page?.hasMore ? `${open.length}+` : open.length} />
      </Stats>
    </Page>
  );
});
export default app;
```

## Zugriff prüfen

Every non-public route admits every signed-in person. Put shared access checks
in `app.use()` before the routes they protect; add handler checks for rules
specific to one route. SDK calls use the Code account's grants, including
shares given to resource Code's service account. The visitor's permissions
do not limit those calls. Public routes have `c.user === null`.

Start with middleware for a private path prefix. Returning a Response stops
before the handler; `return next()` continues. This check also covers later
POST, PUT, DELETE and ALL routes under the prefix:

<!-- check: personal -->
```ts
import { app } from "@sdk";
const allowedUserIds = ["u_example"];
app.use("/private", async (c, next) => {
  if (!c.user || !allowedUserIds.includes(c.user.id))
    return c.json({ error: "forbidden" }, 403);
  return next();
});
app.get("/private/account", c => c.json({ allowed: true }));
app.get("/public/status", c => c.text("Ready"), { public: true });
export default app;
```

Without a prefix, middleware runs on **every** later HTTP route, including
public routes. A global access check must explicitly let intended public
routes through; a private prefix, as above, keeps the rule local. Public
routes still run through matching middleware with `c.user === null`, even
when the visitor is signed in. Registration order matters: earlier routes,
schedules and event handlers are unaffected. Middleware changes neither the
execution owner nor approval requirements; its own SDK calls are checked
and must belong to the version's declared capability set.

Use one explicit field per identifier. `id` is the immutable Cloud user ID;
`username` is the short login handle. `groupIds` and `groupNames` contain the
effective Cloud group IDs and names. IPA groups have Cloud UUIDs assigned on
sync and their IPA group names. Names may change and may coincide with IDs or
usernames. Prefer IDs when the rule must survive a rename. There is no mixed
user/group or ID/name lookup. Group names can repeat across identity providers; a name check admits all matching groups. Prefer `groupIds` for an unambiguous group authorization rule.

A fixed list of user IDs:

<!-- check: personal -->
```ts
import { app } from "@sdk";
const allowedUserIds = ["u_example"];
app.get("/", c => {
  if (!c.user || !allowedUserIds.includes(c.user.id))
    return c.json({ error: "forbidden" }, 403);
  return c.json({ allowed: true });
});
export default app;
```

A fixed list of login handles, compared only to `username`:

<!-- check: personal -->
```ts
import { app } from "@sdk";
const allowedUsernames = ["alex"];
app.get("/", c => {
  if (!c.user || !allowedUsernames.includes(c.user.username))
    return c.json({ error: "forbidden" }, 403);
  return c.json({ allowed: true });
});
export default app;
```

A group name, or independently a group ID. Each route below defines its own
rule; the routes do not combine user and group identifiers:

<!-- check: personal -->
```ts
import { app } from "@sdk";
const allowedGroupNames = ["support"];
const allowedGroupIds = ["00000000-0000-4000-8000-0000000000aa"];
app.get("/by-group-name", c => {
  if (!c.user || !c.user.groupNames.some(name => allowedGroupNames.includes(name)))
    return c.json({ error: "forbidden" }, 403);
  return c.json({ allowed: true });
});
app.get("/by-group-id", c => {
  if (!c.user || !c.user.groupIds.some(id => allowedGroupIds.includes(id)))
    return c.json({ error: "forbidden" }, 403);
  return c.json({ allowed: true });
});
export default app;
```

A Grids allowlist can hold separate text columns for a user ID, username,
group ID and group name. Discover the real Base, Table and Field IDs through
Grids before writing the query. Give the Code account read access to this
Base; allow only trusted editors to change the allowlist. Each non-empty
cell below grants access through its matching identity field. Keep this
allowlist within one complete page (at most 100 rows); an incomplete or
failed result refuses access. The example IDs are fictional.

<!-- check: personal -->
```ts
import { app, grids } from "@sdk";
const allowlist = grids.base("Base01");
app.get("/", async c => {
  const user = c.user;
  if (!user) return c.json({ error: "forbidden" }, 403);
  const { data: result, page } = await allowlist.gql.execute({
    query: "from table {Table01}\nselect {Field01} as uid, {Field02} as username, {Field03} as groupId, {Field04} as groupName\nlimit 100",
    pageSize: 100,
  });
  if (!result.ok || result.truncated || page?.hasMore)
    return c.json({ error: "forbidden" }, 403);
  const allowed = result.rows.some(row => {
    const { uid, username, groupId, groupName } = row.values;
    return (typeof uid === "string" && uid !== "" && uid === user.id)
      || (typeof username === "string" && username !== "" && username === user.username)
      || (typeof groupId === "string" && groupId !== "" && user.groupIds.includes(groupId))
      || (typeof groupName === "string" && groupName !== "" && user.groupNames.includes(groupName));
  });
  if (!allowed) return c.json({ error: "forbidden" }, 403);
  return c.json({ allowed: true });
});
export default app;
```

## Public routes

Public routes never see who is signed in. To recognise visitors, leave out
`public`; then every signed-in person sees the page.

`{ public: true }` opens a route without sign-in. `c.user` is then always
`null`, also for signed-in visitors. Public routes need the public-endpoint
policy and, by default, a Cloud administrator's approval. They share a limit
of 20 requests per minute per client network and Code, and accept bodies up
to 4 KiB. Return only what any visitor may see. Add `layout: "plain"`, as in
`{ public: true, layout: "plain" }`, to draw the page without the Cloud layout
([Pages](pages.md#where-a-page-appears)).

<!-- check: personal -->
```tsx
import { app, jsx, Page, Text } from "@sdk";

app.get("/opening-hours", c => c.page(
  <Page title="Opening hours">
    <Text>Monday to Friday, 9:00 to 17:00.</Text>
  </Page>
), { public: true });
export default app;
```

Public forms and other public requests need no CSRF token. On non-public
routes, forms handle the session-bound token for you; other POST, PUT, PATCH
and DELETE requests send `X-Code-CSRF` from a preceding GET.

## Internet requests and secrets

`http.fetch(url, { method?, headers?, body? })` sends a bounded public HTTPS
request and returns `{ status, headers, bodyBase64, text, json }`. `bodyBase64`
preserves binary bytes. Use `await response.text()` for UTF-8 text or
`await response.json()` for parsed JSON (`unknown`). The
checker records every literal origin in the version; declare dynamic or
redirect origins with a literal `http.allow([...])`. A version with internet
origins needs a Cloud administrator's approval by default, and an internet
request counts as a possible effect: after it, a failed run is not retried
automatically. Cloud's own addresses and private networks are refused.

`secrets.NAME` is a placeholder string such as `[secret:API]`, never the
value. Core puts the value into an allowed header at the approved origin and
path only. An editor sets the value on the Code page's **Secrets** tab or with
`cld code secret set NAME <project> --from <private file or -> --binding <file>`. Never ask for a secret
in the chat and never put one into source, fixtures or URLs.

<!-- check: personal -->
```ts
import { app, http, secrets, spaces } from "@sdk";

const team = spaces.space("Spc001");

app.schedule({ cron: "0 8 * * *", timeZone: "Europe/Berlin", name: "status-check", title: "Status check" }, async () => {
  const response = await http.fetch("https://status.example.com/v1/incidents", {
    headers: { authorization: `Bearer ${secrets.STATUS_API}` },
  });
  if (response.status !== 200) throw new Error(`Status service answered ${response.status}`);
  const incidents: unknown = await response.json();
  if (!Array.isArray(incidents) || incidents.length === 0) return;
  const day = new Date().toISOString().slice(0, 10);
  await team.task.create({ title: `Check ${incidents.length} open incidents`, priority: "high", idempotencyKey: `incidents:${day}` });
});
export default app;
```

The secret's binding (origin, path prefix, allowed headers) is chosen when
the value is set; a version uses the binding that was current when it was
submitted. A changed origin needs a new version. One request follows at most
20 redirects; each must be declared. Choose a trusted service: it receives
the credential.

<!-- check: personal fails code_http_origin_dynamic -->
```ts
import { app, http } from "@sdk";

const host = ["api", "example", "com"].join(".");
app.schedule({ cron: "0 8 * * *", timeZone: "Europe/Berlin", name: "dynamic" }, async () => {
  // The origin is computed: declare it with http.allow(["https://api.example.com"]).
  await http.fetch(`https://${host}/items`);
});
export default app;
```

## Webhooks (R1: ohne Secret)

A webhook in R1 is an ordinary public POST route, for example
`app.post("/hooks/events", handler, { public: true })`. R1 does not verify a
webhook signature; signed webhooks follow later. Code receives no incoming
request headers or cookies, and `c.user` is always `null`. Use `c.req.json()`
or `c.req.text()` to read the body. Public requests need no CSRF token or
binding cookie. The public body and rate limits still apply.

Public pages must submit to public actions. To use a non-public action, open
its non-public page first to obtain the session-bound token. A public page
response removes any earlier token; private form actions then fail with 403
until the private page is opened again. A failed mutation is never retried
automatically.

**ID nehmen → beim Dienst nachlesen → handeln.** Take only the event or object
ID from the untrusted body. Read its real state from the service with
`http.fetch` and a secret placeholder; only then act. Never put a credential
in Code source or treat a token in the URL as protection. Anyone can trigger
the public route: validate the returned state, constrain the effect and use
its stable ID for idempotency. This pattern confirms service state, not who
sent the notification.

Before submitting, an editor configures `EVENTS_API` privately in the Code's
**Secrets** tab with this binding. Submission selects its current binding
revision for the version; the example declares the same origin. The credential
belongs to the outgoing service request, never to the incoming webhook:

```json
{
  "origin": "https://events.example.com",
  "pathPrefix": "/v1/events",
  "headers": ["authorization"]
}
```

Give the Code account access to the destination Space and obtain the public-route
and internet approvals. Keep the `/hooks/` exception before the global
access check, or scope access middleware to a private prefix.

<!-- check: personal -->
```ts
import { app, http, secrets, spaces } from "@sdk";

http.allow(["https://events.example.com"]);
const team = spaces.space("Spc001");

app.use(async (c, next) => {
  if (new URL(c.req.raw.url).pathname.startsWith("/hooks/")) return next();
  if (!c.user) return c.json({ error: "forbidden" }, 403);
  return next();
});
app.post("/hooks/events", async c => {
  // Only the ID comes from the untrusted notification.
  const notification: unknown = await c.req.json();
  if (!notification || typeof notification !== "object" || !("id" in notification)
      || typeof notification.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(notification.id))
    return c.json({ error: "invalid_id" }, 400);
  const response = await http.fetch(`https://events.example.com/v1/events/${notification.id}`, {
    headers: { authorization: `Bearer ${secrets.EVENTS_API}` },
  });
  if (response.status !== 200) return c.json({ error: "service_unavailable" }, 502);
  let event: unknown;
  try {
    event = await response.json();
  } catch {
    return c.json({ error: "invalid_service_response" }, 502);
  }
  if (!event || typeof event !== "object" || !("id" in event) || event.id !== notification.id
      || !("status" in event) || event.status !== "ready"
      || !("title" in event) || typeof event.title !== "string")
    return c.json({ error: "event_not_ready" }, 409);
  // Only the service's confirmed state determines the effect.
  await team.task.create({ title: event.title, idempotencyKey: `service-event:${event.id}` });
  return c.json({ accepted: true });
}, { public: true });
export default app;
```
