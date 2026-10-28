---
title: Lessons learned
navTitle: Lessons learned
section: Contributing
order: 1305
description: Name the error class of each bug and the guard that catches that class next time, and read the incidents that taught each class.
tags: [contributing, testing, quality]
updated: 2026-10-24
---

# Lessons learned

A bug that is fixed once can come back in another place. To stop that, every
fix names the error class of its bug, then adds or names the guard that
catches that class next time. A guard is a repository check under
`scripts/checks/`, a test that fails on the bug, or a named convention that
reviews apply. Checks and tests fail on their own. A convention works only
while reviews apply it, and a rule that nothing checks decays. The error-class catalog marks
each guard as a check, a test, or a convention, so a class that has only a
convention still needs a check or a test.

This page is assembled by Fibel from the files in
`docs-site/docs/en/contributing/lessons/`. Do not add entries to this file.

## Add a lesson

Add one Markdown file at
`docs-site/docs/en/contributing/lessons/YYYY-MM-DD-<unique-slug>.md`.
Include the PR number in the slug when known. Each PR adds its own file;
leave this page and other entries unchanged.

Use one level-three heading and four fields:

```markdown
### A short description of the failure

- **What happened:** The observable failure.
- **Root cause:** The confirmed cause.
- **Error class:** The kind of mistake that could recur elsewhere.
- **Guard:** The check, test or convention that catches the class next time.
```

When neither the code on `main` nor a test confirms the root cause, start it
with "Suspected:"; the fix pull request replaces it with the confirmed cause.
When the guard does not exist yet, write "Pending in #n" with the issue that
tracks it, or "None, because …". A new guard for an existing class gets its
own lesson file describing that class and guard.

Dated lessons appear newest first, with the filename breaking same-day ties.
The undated migrated lessons follow in filename order. The alphabetical
error-class catalog combines the migrated rows in `lessons/classes/` with the
class, failure and guard fields from every new lesson. Older rows record the
guard at the time of the fix; a later lesson can record a stronger guard.
The files are Markdown fragments without frontmatter; the date belongs in
the filename.

### Update an open pull request

After merging or rebasing onto this change, keep the version of
`lessons-learned.md` from `main`. Move your added lesson or table row into a
new dated file using the four fields above, then remove your edits to the
shared page. Move any additions to an existing lesson into your new file too.
Do not commit an expanded or generated copy of this page.

## Error classes

<!-- lesson-classes -->

## Lessons

<!-- lesson-entries -->
