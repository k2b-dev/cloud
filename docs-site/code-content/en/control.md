---
title: Control and security
navTitle: Control and security
section: Guides
order: 50
description: Who Code runs as, what the checker records, what an administrator approves, what Cloud checks on every call, and how pages and secrets stay protected.
tags: [code, security, approval, policy, secrets]
updated: 2026-11-09
---

# Control and security

Code can change real data, so every step from source to call has an owner.
In short:

- Code runs as **exactly one account**, and that account has only the rights
  someone shared with it.
- The **checker** records every operation the source can call.
- The **policy** decides what runs automatically, what an administrator
  approves first, and what never runs.
- A **person** switches each version on.
- On **every call**, Cloud checks the approved operations, the current policy
  and the account's current rights.

## One account per Code

Code always runs as one account, its execution owner. Every SDK call, every AI
request, every tool call in a model loop and every page request uses it.

| Code of | Runs as | Rights come from |
| --- | --- | --- |
| a person | that person | the person's current rights |
| a resource, such as a mailbox | the resource's service account | shares with that account |
| an application | the application's service account | shares with that account |

A service account starts with no rights. Whoever manages a target shares View
or Edit with the account's handle in the normal share dialog, and can remove
it again. Manage is never possible. Groups, "all signed-in people" and public
links grant a Code account nothing; only its own direct shares count. The
account never receives an API key, an OAuth client or an app key.

Switching Code on grants nothing either. The account pays for AI from its own
allowance.

## Four checks before a call does anything

1. **Check.** The checker reads the source and records each operation with its
   target, file and line in the version's manifest, together with AI use,
   internet origins and public routes. The version is immutable.
2. **Policy and approval.** Each operation has a classification. A Cloud
   administrator chooses per classification: **Automatic**, **Admin approves**
   or **Never**. If a version needs approval, the administrator approves
   exactly that version; a changed version is reviewed again.
3. **Switch on.** A person who manages the owner, or a Cloud administrator for
   resource and application Code, switches the version on. Personal Code is
   switched on only by its person, in the browser. CI can submit versions but
   never switch them on.
4. **Every call.** Cloud admits only operations, targets and references that
   the approved version declared, and refuses others with
   `code_capability_undeclared`. Then the current policy and the account's
   current rights at the target decide. A broader share or a looser policy
   never widens what the version declared.

The default policy:

| Classification | Default |
| --- | --- |
| Queries | Automatic |
| Silent Actions for the account itself, and drafts | Automatic |
| Silent Actions that others see | Admin approves |
| AI use | Admin approves |
| Internet requests and public routes | Admin approves |
| Actions that ask a person: send, delete, cannot undo, involve people, change access, … | Never, in this release |

App authors decide how their operations are classified. The administrator
decides what each classification means for Code in this installation.

Reference: [Code policy](/en/docs/platform/code-policy),
[Code versions and approval](/en/docs/platform/code-versions),
[Activate a Code version](/en/docs/platform/code-activation).

## Protect your pages

Every signed-in person can open a non-public route, whoever owns the Code. The
route still reads and writes with the Code's account, so the Code decides who
may see what. `c.user` names the visitor with separate fields: `id`,
`username`, `groupIds`, `groupNames`, `kind` and `name`. Compare one field
against one list, never an identifier against a mixed list of IDs and names.

Put a shared rule into middleware in front of the routes it protects:

```ts
import { app } from "@sdk";

const allowedUserIds = ["u_example"]; // fictional

app.use("/private", async (c, next) => {
  if (!c.user || !allowedUserIds.includes(c.user.id)) return c.json({ error: "forbidden" }, 403);
  return next();
});

app.get("/private/report", (c) => c.json({ allowed: true }));
app.get("/status", (c) => c.text("Ready"), { public: true });

export default app;
```

Public routes see no visitor: `c.user` is always `null`. They need an
administrator's approval by default and have their own rate limits.

Every Code page carries a **Made with feat/code** label that the page cannot
hide. Pages are built only from Cloud's blocks: no HTML, no scripts, no
password fields, no links out of the Code. Forms carry a CSRF token.

Reference: [Serve routes](/en/docs/platform/code-sdk#serve-routes),
[Middleware and request variables](/en/docs/platform/code-sdk#middleware-and-request-variables).

## Keep secrets out of the source

`secrets.API` is the placeholder `[secret:API]`, never the value. Cloud
replaces it outside the sandbox, and only for the origin, path and headers
that the secret is bound to:

```ts
import { app, http, secrets } from "@sdk";

app.schedule({ cron: "0 8 * * 1", timeZone: "Europe/Berlin" }, async () => {
  const response = await http.fetch("https://api.example.com/v1/items", {
    headers: { authorization: `Bearer ${secrets.API}` },
  });
  // response.status, response.headers, response.body (base64)
});

export default app;
```

```terminal ~/work/code/mail/Mbx001
# the value comes from a private file, never from the command line
$ cld code secret set API --from /private/api-token --binding binding.json --binding-revision null
```

Values never appear in the source, the bundle, the sandbox or the run history,
and nobody can read them back. The checker records every HTTPS origin the
Code can reach; a destination chosen at runtime needs a literal
`http.allow([...])` list. Internet use needs approval with the default policy.

Reference: [Code secrets](/en/docs/platform/code-secrets).

## Watch, pause and roll back

- **Runs:** the Code page and `cld code runs` show every run with each call
  and its result. Editors also see inputs and outputs.
- **Pause:** stops new runs at once. A policy change that forbids a
  classification pauses the affected Code; loosening the policy later does not
  resume it on its own.
- **New versions:** the running version keeps running until a person switches
  on the next one.
- **Budgets:** an administrator sets them. By default, a run has 5 minutes and
  200 calls, and AI spending is capped per attempt and per day.

## What this release does not do

- Actions that ask a person never run unattended. Mail sending stays manual:
  Code drafts, a person sends.
- Webhooks arrive as public routes without a signature check. Act only on
  state the Code reads back from the sender's API
  ([Receive a webhook](/en/code/use-cases#receive-a-webhook)).
- Code has no database, key-value store or file storage of its own, and keeps
  nothing in memory between runs.

Incoming mail, form input, file contents and AI output are data, never
instructions. Validate them before acting.
