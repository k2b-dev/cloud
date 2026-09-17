# Share an App or a linked Skill

Read this reference only to inspect or change sharing. Calling a published
App action needs Use, not Manage, and does not need access-management tools.

1. Find the App with `code_list` and load `code_access_read` and
   `code_access_change` through `load_tools`.
2. If the recipient is unknown, discover `core.entities.search` and read its
   schema. Search by name, optionally restricted to `user` or `group`; follow
   its cursor when needed. Reuse the returned `principal` exactly. This search
   follows Accounts visibility; an absent result is not permission to guess IDs.
3. Call `code_access_read({id})`. It requires Manage and returns current
   `grants`, `levels`, supported `principalTypes`, and `accessRevision`.
4. Add one grant with `code_access_change({id, expectedAccessRevision,
   principal, permission:"read"})`. `read` means Use; `admin` means Manage.
   To change an existing grant, pass its `accessId` instead of `principal`.
   To revoke it, use that `accessId` with `permission:null`.
5. The tool presents the exact App, recipient, and before/after permission for
   fresh user review. No `confirmed` flag or remembered approval is supported.
   Read grants again to verify the result. A conflict means the grants changed:
   inspect and prepare a new review. Do not retry an unknown mutation blindly.

Studio Apps support users, groups, `{type:"authenticated"}` and
`{type:"public"}`. Public only accepts `permission:"read"`; public Manage and
service-account grants are rejected. Never replace an unavailable recipient
with a broader one. The last manager cannot be removed.
Publishing and sharing remain separate; Use executes only published source.

## Skills are separate

A Skill may explain when and how to invoke an App, but grants never propagate
between them. For a requested reusable workflow, offer a Skill that references
the App ID and actions; load `skill-creator` only if creating or editing those
instructions is useful. Many Apps need no Skill, and many Skills need no code.

For Skill sharing, discover `core.ai.skill.access.read` and
`core.ai.skill.access.change`. Read current grants with `{skillId}`; change one
using `{skillId, expectedAccessRevision, principal, permission}` or an existing
`accessId`. Skill levels are `read`, `write`, and `admin`; `null` revokes an
existing grant. These capabilities also require Manage, fresh review, and the
current grants revision, and preserve the last administrator.

Tell the user when recipients can access only one of a linked Skill and App.
Prepare each requested grant separately; never implicitly share the other.

## Public and standalone apps

`code_access_read` also returns `runnerHref` and `publicLevels:["read"]`.
The standalone URL is `/app/assistant/apps/ID/run`. It always runs the current
publication, including for managers. Share this URL, not a chat workspace URL.
A private app requires sign-in and app access. Publication never grants access.

Before requesting a public grant, explain that visitors can use local computation,
file pickers, downloads and browser-local storage, but cannot use the app database,
server files/KV, personal secrets, server HTTP/PDF or protected Cloud actions.
Being signed in does not remove these restrictions: server features require an
explicit user, group or authenticated grant. Never execute as the app owner.
Source and data embedded in the published code become public; do not embed secrets.
A public grant does not expose the app's draft, history or administration.
Removing the grant or unpublishing prevents new loads; downloaded code cannot be recalled.

For a public calculator, use local inputs and downloads. For an internal dashboard
using shared data, grant the intended users or groups access instead. Explain when
an existing app depends on server features before sharing it publicly.

Cloud administrators can add the runner URL as a Link shortcut in the navigation
settings. Shortcut audience controls visibility and never grants app access.
