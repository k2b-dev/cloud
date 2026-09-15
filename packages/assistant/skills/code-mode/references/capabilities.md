# Combine Cloud capabilities

Discover the actual capability through the normal capability search and load its
input contract before writing code. Try a read query directly when that helps
understand its result. Never guess a capability name, input field, or result path.

For comparisons or analysis, a one-off script can call several discovered read
capabilities, normalize their results, and return a compact comparison. Inspect
pagination, identifiers, units and date ranges before joining or totaling data.
Use a fresh short script for another question; no saved app is required. A
sample is not evidence that all records were fetched. Shared writes and actions
remain real even when the script is exploratory.

Inside a script or app, call:

```ts
const result = await capabilities.run("app.capability", { /* documented input */ });
const data = result.data;
```

The name and input must match the discovered capability. The result is the
capability result envelope, including `data` and any supplied references or
files. Inspect its documented shape before chaining it into another call.
Await dependent calls in order. Catch failures when the task has a useful
recovery; do not swallow them and report success.

The current user's Cloud permissions still apply. Read queries and actions
configured without approval run directly. Other actions request real user
approval through the chat or app host. An eligible action can offer “always
allow” for its defined scope. Existing remembered approvals are reused.
Scripts cannot approve their own requests; `code_interact` is not an approval
mechanism. Declined calls throw. Respect the decision and do not retry through
another route. A chat's allowed-tools restriction also applies to calls from
its scripts.

Failures reject the promise; the runtime removes the transport `{ok, data}`
wrapper. The returned object is the capability's own envelope (`data`, `refs`,
files when supplied), not a second transport wrapper.

Use the user's current request to decide which effects are appropriate. The
availability of a tool is not a reason to invoke unrelated actions.

When the user runs a saved resource they do not manage, every capability call
requires explicit consent, including queries and actions normally needing no
approval. The dialog identifies the resource and explains that returned data
can be stored in shared files or its database. Personal remembered approvals
do not apply, and these calls cannot create a personal always-allow rule.
Denial must leave a useful message; do not retry unchanged or bypass consent.
