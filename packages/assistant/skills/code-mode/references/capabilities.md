# Combine Cloud capabilities

Discover the actual capability through the normal capability search and load its
input contract before writing code. Try a read query directly when that helps
understand its result. Never guess a capability name, input field, or result path.

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

The interactive CLI prompts for confirmation. Unattended CLI execution needs
explicit authorization for the capability through its approval options; code
itself never supplies an approval flag. No session cookie or API token belongs
in app source.

Use the user's current request to decide which effects are appropriate. The
availability of a tool is not a reason to invoke unrelated actions.
