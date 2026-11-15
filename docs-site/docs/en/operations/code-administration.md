---
title: Administration › Code
navTitle: Code administration
section: Operations
order: 1256
description: Approve Code versions, edit the Code policy, see all Code, waiting cleanup, limits and runner capacity.
tags: [operations, code, policy, approvals, administration]
updated: 2026-11-15
---

# Administration › Code

Cloud administrators manage everything that runs as Code under
**Administration › Code** (`/admin/code`). The page uses the same column
pattern as the AI area: sections on the left, a list, and the selected item.
Every selection is part of the URL, so reload, back and shared links return to
the same place. Other people see a no-permission state; the page has no
partial view for them. The "Code" entry in the Administration sidebar shows the
number of open Code-version approvals for the signed-in Cloud administrator,
plus the open reports on Code pages.

| Section | What it shows | Source of truth |
| --- | --- | --- |
| Approvals | Versions that wait for a Cloud administrator, and recently decided versions | [Code versions](/en/docs/platform/code-versions) |
| Code in this Cloud | Every Code with owner, status and last run. A resource owner shows the name its app's reader gives you, or a generic type label when you may not read it | [Code data model](/en/docs/platform/code-data-model) |
| Policies › Default, Groups, Effective for …, History | The policy table, group rules, the resolved table for one person, and recent changes from the audit log | [Code policy](/en/docs/platform/code-policy) |
| Operations › Cleanup | Pending Code deletion jobs, with status, attempts and the last error | [Code lifecycle](/en/docs/platform/code-lifecycle) |
| Operations › Limits | Registered Code execution and storage settings | [Code policy operations](/en/docs/operations/code-policy) |
| Operations › Runners | Instances, free slots, queue length, longest wait | [Code runner](/en/docs/operations/code-runner) |

Guests cannot create Code or submit versions; authoring requires a Cloud member with the usual owner or editor rights.

## Approve or reject a version

A version lands under **Approvals** when one of its classifications resolves
to **Admin approval** for its author or owner. **Approvals** is a page of its
own: each row names the automation and version, who submitted it, whom it
belongs to, its main change and the policy reason. **Open** and **Decided**
are its two views.

A review has a head with the submitter, how the version arrived (with Gustav or
from the command line), its owner, its place in the open list, and one row of
tabs, kept in the URL as `?tab=code` or `?tab=diff`:

- **Overview**: the approval with the reason, what changes in words against the
  compared version, the tried examples and the three decisions; beside it what
  the version does (an AI explanation, marked as not checked by Cloud, asked
  once per version and language), the comments, everything the version may do,
  and the examples. Phones stack the two columns.
- **Code**: the new version's complete source, read-only, in a field of fixed
  height. Its count is the number of comments.
- **Diff**: the difference against the last approved or switched-on version,
  with the number of added and removed lines on the tab. A first version has no
  difference; the tab is there but locked.

Both views come with the page; switching tabs loads nothing.

The decision is bound to the exact version, source hash, bundle hash and
comparison under review. Cloud rechecks all of them when you decide. A
newer submission, a moved comparison or a Code difference that could not be
loaded disables **Approve** and names the reason. **Request changes …** and
**Reject …** open a dialog with a required message; it names who receives it,
which version stays switched on, how many comments go along, and for a version
from Gustav that Gustav revises it once by itself. A refused decision keeps the
dialog and its text open. When the answer is lost, the review shows
**Outcome unclear** with the unconfirmed message and only **Check state**; no
decision is possible until the saved state is read. When another administrator
decided first or the version was withdrawn meanwhile, the reloaded review says
so. Approval accepts an optional message. Negative decisions keep the proposed version off; the current
active version keeps running. The first version leaves the automation off.
Cloud administrators receive a submission notice; the submitting person and
current Code editors receive the decision, with a link to that version.
Reviews expire after 14 days.

Administrators can add line comments and replies while a review is pending:
the **+** at the start of a line in **Code** or **Diff** opens a thread directly
under that line (one tab stop for the code; the arrow keys, Home and End move
between lines, Enter comments). Code and Diff show the same thread at the same
line; an unchanged file in **Diff** lists its commented lines. A comment that
cannot be saved keeps its text with **Try again**, and **Load older comments**
pages back. Only the author may delete a comment before the decision; the
decision freezes the comments, and the review then shows no **+** and no reply
field. Ordinary Code surfaces show the comments as text without file
names or line numbers. The CLI and Gustav can read the exact anchors.

The approval list includes the author, avatar, submission time, owner, strictest
policy reason and a sentence describing it. A place name is resolved only when
the administrator can read that place; otherwise only its type is available.
A follow-up version also carries the current administrator's request for changes
and comments from the directly preceding version; the review shows them on top
as "You requested changes to version N". After a decision the review reloads with its result at the top
and moves focus there. A decision cannot be withdrawn. To take an approval back, pause
the Code: Cloud administrators can pause and resume any Code from its detail
under **Code in this Cloud**. Resuming checks the active version's approval
under the current policy again.

Authors do not approve their own versions. The one exception is an
installation with exactly one active Cloud administrator: the review then
shows that you are approving your own Code, and the version list labels the
result "self-approved (only admin)". This requires a full browser sign-in with
the same account from the last ten minutes, or a decision through Cloud Login.
When confirmation is missing, **Sign in again** returns to this exact review
after sign-in. Emergency administrators use **Sign out and use admin token**: Cloud first
finishes signing this account out, then opens the token sign-in and returns to
the review. A failed sign-out stays visible. Reload to check your current sign-in,
or try signing out again.
A phone app session, personal API key or OAuth credential cannot replace this
browser confirmation.

A refused decision explains the next step: ask another active admin when you
authored the version, open the review in Cloud when the connection only permits
rejection, or return to the approvals list when the request is unavailable to
your account. The review shows these instructions in English and German without
technical error codes.

## Read a version's Code

A version's source shows only in its review, in the **Code** and **Diff** tabs.
The former **View code** in a Code's detail under **Code in this Cloud** is
gone; a link with a `version` parameter now points to that version's review.
Each version in the detail opens its review. Like the other reads in this area
it needs the Cloud administrator role and writes no audit entry.

## Edit the policy

**Default** shows the presets as choices (Off, Admin approval, Open, Custom)
and one framed table with a radio group per classification: Automatic, Admin
approval or Never, with the number of automations that use it. Classifications
that always need a person are listed separately and cannot change. A preset
replaces the whole table, including group rules. **Groups** edits one group's rules; a row set to
"As default" has no group rule. **Effective for …** resolves the table for one
person and names the rule that decided each row.

Before saving, the bar under the table says what changes, with the old value
struck through, and names every automation the change would pause; the save
button says how many it pauses. Saving is bound
to the policy revision you read. If another administrator saved first, the
change stays on the page and **Check my change again** applies it on top of
the newer policy and previews it again. A refused save changes nothing and keeps
the change for **Save again**. When the answer to a save or decision is lost,
the page says so and offers **Check state** instead of claiming that nothing
changed.

**History** lists recent policy changes from the audit log: who saved, when,
and each changed row with its old value struck through and its new value. Code keeps no history store
of its own.

## Reported pages

Every page a Code serves under `/code/<id>/…` carries a label with a card.
Members of the Cloud can report the page there; visitors without an account
and guests cannot. A report names the person, the page path, an optional
reason and a short text. It goes to every Cloud administrator as the
**Reported Code pages** notification, with links to the page and to the
automation under **Code in this Cloud**; the Code's owner is not notified.
Administrators who did not turn the notification off receive it in the browser
and by email.

The automation's detail shows **Reported pages** while reports are open, with
**Mark done** for each report and **Pause** for the whole automation. Marking a
report done tells the person who filed it, without naming the administrator.
Each person has one open report per page and can file ten reports per hour.
Open reports stay until an administrator marks them done; Cloud deletes done
reports 30 days later, like the automation's run history, and deletes all
reports with their Code.

## Browser routes

The page calls Core routes under `/api/code/admin`. They require the Cloud
administrator role and use the same services as the `core.code.*`
capabilities and `cld code`:

| Route | Purpose |
| --- | --- |
| `POST /api/code/admin/decide` | `{ binding, approved }`; `binding` is the unchanged `CodeVersionBinding` |
| `POST /api/code/admin/pause` | `{ codeId, paused }`; pause or resume any Code |
| `POST /api/code/admin/policy/read` | The current policy with its revision |
| `POST /api/code/admin/policy/preview` | Paused Code for a complete replacement table, with owner names |
| `POST /api/code/admin/policy/update` | Replace the table at the read revision |
| `POST /api/code/admin/reports/list` | `{ codeId, state?, cursor? }`; one page of 20 reports on the automation's pages, newest first |
| `POST /api/code/admin/reports/resolve` | `{ codeId, reportId }`; mark one report done and tell the person who filed it |

A stale revision, hash or comparison returns `409`. The decision route preserves
the platform refusal in its stable `code`: `SELF_APPROVAL`, `REAUTHENTICATE` and
`REJECT_ONLY` return `403`; `NOT_FOUND` returns `404`. Clients use the code to
choose a recovery message rather than displaying transport diagnostics.
`BUSY` and `UNAVAILABLE` keep their `409` status and their own stable codes, with
instructions to retry rather than reporting a changed version.

## Pending Code deletion

When a Code owner is deleted, Cloud stops its Code and schedules deletion.
**Cleanup** shows pending deletion jobs, including jobs waiting for an
activation to drain. Cloud retries automatically; completed jobs disappear.
An empty list means no Code or unused-database deletion jobs are pending.

To change a service account's access, use the target's normal share dialog.
You must manage that target; the Cloud administrator role alone does not give
that permission. Cleanup provides no action to remove target access.

## Runner section

The runner section shows the `CodeRunnerMetrics` read model as one line of
figures (runners, free places of all places, waiting runs, longest wait) and
one row per runner with its places: taken places filled, free ones empty, and
"n of m places free". Places are a runner's free slots plus the runs it holds.
When no runner is connected or the queue grows while no place is free, a notice
says so and what follows. When the queue grows and the waiting time rises, add
runner instances.
Automatic scaling is not part of Phase 1.

## Unused databases

**Unused databases** lists inactive Code whose latest and selected versions do
not declare `database`. Each page contains at most 20 rows, with Code, owner,
last measured size, unused start, deletion date and last database access.
A dash means no measurement or access has been recorded. Each row offers
**Export** and confirmed **Delete now**. The selection and next page remain in
the URL. Deleting a database preserves its Code and releases the owner quota
immediately; failed RSQL removals appear under **Cleanup** and retry automatically.

The default deadline is 30 days. New and recalculated deletion dates remain
visible for at least the seven-day reminder period, including after shortening
or re-enabling retention and for resource or app owners. Change **Unused database retention (days)**
under **Limits**, or use `core.code.database_unused_days` with
`cld admin settings apply`; zero switches automatic deletion off. See
[Code storage](/en/docs/operations/code-storage#database-lifecycle) before
shortening the period.

## Source access for automation review

Source text, executable bundles and source differences require editor rights
on the automation. This also applies to Cloud administrators using the
ordinary Code APIs, the Code tab and `cld code pull`. Reader access continues
to allow version metadata, checked facts and confirmed activity.

The separate `readCodeAdminVersionSource` service is the sole administration
exception: Cloud administrators may read source for approval review through
that read-only path. It does not confer editorship or authorize CLI downloads.
