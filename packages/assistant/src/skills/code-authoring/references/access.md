# Access and secrets

Code never gets more access than its account has. A version, a check, a
handle or a setting that names a resource grants nothing.

## Who the Code runs as

| Owner | Runs as | Who switches it on | Notes |
| --- | --- | --- | --- |
| Personal | Its person, with their current access | Only that person, in a browser session | Its non-public routes open only for the owner; others get 403 `code_owner_only`. Can use `core.ai.chat.*` in the owner's own chats. |
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

Routes need a signed-in person by default. `c.user` is `{ id, groups }`: the
person's ID and effective group IDs. Use it to decide what a page shows or
which form it accepts. It is never data authority: every SDK call runs with
the Code's account, not the visitor's access. A page therefore must not show
mailbox data to a visitor who should not see it.

<!-- check: resource mail.mailbox -->
```tsx
import { app, jsx, owner, Page, Notice, Stats, Stat } from "@sdk";

// Fictional group ID of the team that may see this page.
const TEAM = "00000000-0000-4000-8000-0000000000aa";

app.get("/", async c => {
  if (!c.user?.groups.includes(TEAM))
    return c.page(<Page title="Team inbox"><Notice tone="warning" title="Only for the support team" /></Page>);
  const open = await owner.conversation.list({ view: "needs_action", limit: 50 });
  return c.page(
    <Page title="Team inbox">
      <Stats>
        <Stat label="Needs action" value={open.length >= 50 ? "50+" : open.length} />
      </Stats>
    </Page>
  );
});
export default app;
```

## Public routes

`{ public: true }` opens a route without sign-in. `c.user` is then always
`null`, also for signed-in visitors. Public routes need the public-endpoint
policy and, by default, a Cloud administrator's approval. They share a limit
of 20 requests per minute per client network and Code, and accept bodies up
to 4 KiB. Return only what any visitor may see.

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

Forms on pages handle the CSRF token for you. Other POST, PUT and DELETE
requests send the `X-Code-CSRF` header from a preceding GET.

## Internet requests and secrets

`http.fetch(url, { method?, headers?, body? })` sends a bounded public HTTPS
request and returns `{ status, headers, body }` with a base64 `body`. The
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

app.schedule({ cron: "0 8 * * *", timeZone: "Europe/Berlin", name: "status-check" }, async () => {
  const response = await http.fetch("https://status.example.com/v1/incidents", {
    headers: { authorization: `Bearer ${secrets.STATUS_API}` },
  });
  if (response.status !== 200) throw new Error(`Status service answered ${response.status}`);
  const incidents: unknown = JSON.parse(atob(response.body));
  if (!Array.isArray(incidents) || incidents.length === 0) return;
  const day = new Date().toISOString().slice(0, 10);
  await team.task.create({ title: `Check ${incidents.length} open incidents`, priority: "high", idempotencyKey: `incidents:${day}` });
}, { name: "status-check", title: "Status check" });
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
