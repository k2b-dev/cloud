---
title: Ship Assistant Skills
navTitle: Assistant Skills
section: Platform services
order: 585
description: Ship app-owned Assistant Skills as Markdown files that Cloud installs, updates, and shows only to people who may open the app.
tags: [ai, assistant, skills, markdown, agents]
updated: 2026-10-10
---

# Ship Assistant Skills

An application can teach Assistant how to work with it. It ships each Skill as
a `SKILL.md` file with optional Markdown references. Cloud installs the Skill
when the app registers, updates it when a new release changes the content, and
offers it only to people who may open the app.

Built-in apps and third-party apps use the same contract. No Cloud release or
repository change is needed to add, change, or remove an app's Skills.

| The application owns | Cloud owns |
| --- | --- |
| Skill content, names, and descriptions | Validation, bundling, and delivery |
| Which Skills it ships in a release | Installing, updating, and tombstones |
| Who may open the app (`nav.requiresRoles`, `adminHref`) | Access, availability, and the Assistant catalog |
| Capabilities the Skill names | Administrator overrides, diff, and reset |

A Skill grants no permission. It tells Assistant which capabilities to use and
how; every capability still authorizes the actor. Use [Help](/en/docs/platform/help)
for product guidance that people read, and a Skill for how Assistant should do
the work.

## Keep Skills in one module

Put the declaration in `src/skills.ts` and one folder per Skill below
`src/skills/`. The folder name is the Skill name:

```text
src/
├── skills.ts
└── skills/
    └── inventory-counting/
        ├── SKILL.md
        └── references/
            └── count-sheets.md
```

Cloud does not scan the filesystem. Import every file with
`with { type: "text" }` and list it explicitly, as for Help. The build bundles
the text into the app image, so a running app never reads Skill files from
disk.

```ts
// src/skills.ts
import { skill } from "@k2b/cloud";
import inventoryCounting from "./skills/inventory-counting/SKILL.md" with { type: "text" };
import countSheets from "./skills/inventory-counting/references/count-sheets.md" with { type: "text" };

export const SKILLS = [
  skill({
    markdown: inventoryCounting,
    references: { "references/count-sheets.md": countSheets },
  }),
];
```

Pass the list to `defineApp`, next to the app's notifications:

```ts
// src/config.ts
import { defineApp } from "@k2b/cloud";
import { SKILLS } from "./skills";

export const app = defineApp({
  id: "inventory",
  name: "Inventory",
  // …
  skills: SKILLS,
});
```

TypeScript needs a module declaration for Markdown imports. A Cloud monorepo
app includes `packages/cloud/src/types/*.d.ts`; a standalone app can declare it
once:

```ts
declare module "*.md" {
  const content: string;
  export default content;
}
```

## Write a Skill

`SKILL.md` uses the same format that people import in **Assistant settings >
Skills**: YAML frontmatter with `name` and `description`, then the Markdown
instructions. See
[Reuse shared Skills](/en/docs/ai/files-projects-and-personalization#reuse-shared-skills)
for the format and how Assistant discovers and loads Skills.

```md
---
name: inventory-counting
description: Use for stock counts in Cloud Inventory: planning a count, recording counted quantities, and explaining differences. Load it whenever a request involves a stock count, a count sheet, or a quantity difference.
---

# Count stock in Inventory

Find the location with `inventory.location.list` before counting. …

For printed count sheets, read [Count sheets](references/count-sheets.md).
```

The description is always visible to Assistant and decides when it loads the
Skill. Say what the Skill is for and when to load it. Name app operations by
their qualified capability ID, such as `inventory.location.list`, so Assistant
can load them without searching.

Link references relatively, as `references/<file>.md`. The links work in the
checkout, and Cloud rewrites them to the path Assistant reads them from,
`/skills/<name>/references/<file>.md`. Assistant reads a reference only when the
instructions send it there.

`skill()` validates the Skill when the app starts. A wrong Skill stops the
start with an error that names it:

| Rule | Limit |
| --- | --- |
| `name` | Lowercase letters, numbers, and single hyphens; at most 64 characters; unique within the app |
| `description` | 1 to 1,024 characters |
| Instructions | At most 100,000 characters and 500 lines |
| References | Paths `references/<file>.md`; at most 50 files, 100,000 characters each, 1,000,000 together |
| Mentioned references | Every `references/<file>.md` the instructions mention must be declared |
| Optional frontmatter | `license`, `compatibility`, `metadata`, `allowed-tools`; at most 20,000 characters |
| All Skills of one app | Their catalog lines (`- name: description`) fit the 8,000-character Assistant catalog |

The last rule exists because Assistant sees the name and description of every
Skill it may use in each turn. One app cannot fill that catalog on its own.

## Updates follow the content

There is no version number. Cloud compares a hash of the complete content: name,
description, instructions, optional frontmatter, and every reference. When a
release changes any of it, the next start of the app updates the installed
Skill. Personal **Enabled** settings, access, the Skill ID, and chats that
already loaded the Skill stay as they are; a chat that loaded the Skill keeps
that revision for the rest of the turn.

The app publishes its Skills with its registration, like
[Help](/en/docs/platform/help). During a rolling update, the most recently
started instance decides the content. Core installs and updates the Skills in
the background; it never runs app code.

To rename a Skill, ship it under the new name. The old one becomes unavailable
and an administrator can delete it.

## Who can use an app Skill

An app Skill is offered to a person who may open the app, by the same rule as
the app's [Help](/en/docs/platform/help#who-can-read-help):

- `nav.requiresRoles` limits the Skills like the navigation; `guest` admits
  guests. A Skill of an app with `requiresRoles: ["user"]` is not offered to
  guests.
- An app reached only through the admin area, with `adminHref` and no own
  `nav`, offers its Skills to administrators.
- Without either declaration, everyone who is signed in can use them.

Cloud installs each new app Skill with `read` access for all signed-in
accounts, within this audience. An administrator can still give a specific
person, group, or service account access; such a grant does not depend on the
app's audience. Like every Skill, an app Skill can be turned off personally.

Unlike Help, a Skill does not need a user. A service account without a user
counts as signed in but has no roles: it can use the Skills of apps without
either declaration, and other app Skills only through a direct grant.

When the app is stopped or removed, Cloud keeps its Skills but no longer offers
them. They do not appear in Assistant, cannot be loaded, and their reference
files are not readable. They return when the app registers again. The same
applies to a Skill the app no longer ships.

## Administrators can override an app Skill

**Administration > AI Skills** shows the source of every Skill, such as
**From app Inventory**, and its state:

| State | Meaning |
| --- | --- |
| **Current** | The content is the app's version. |
| **Customized** | An administrator changed the Skill. The app has not shipped new content since. |
| **App update available** | The Skill is customized and the app ships different content. |
| **App not available** | The app is stopped, removed, or no longer ships this Skill. |

App Skills ship with read access only. To change one, an administrator gives
themselves or another person write access under **Permissions** and edits it in
**Assistant settings > Skills**. Cloud keeps the change; app updates no longer
replace it. **Compare with app version** shows the differences, and **Reset to
app version** replaces the content with the app's version and lets later
updates apply again.

Deleting an app Skill is permanent across restarts: Cloud does not install it
again. **Restore** under **App Skills not installed** installs it again from
the app's version.

When a Skill with the same name already exists, Cloud does not install the app
Skill and never changes the existing one. The administration page lists it as
**Name in use**. An administrator can either take over the existing Skill for
the app with **Use existing Skill**, which keeps its content as a customization,
or rename or delete the other Skill and then select **Install**.

The same actions are available through the CLI:

```bash
cld admin ai skills list
cld admin ai skills reset <skill-id> --revision <revision> --app-version <app-version> --yes
cld admin ai skills restore <app-id> <name> --yes
cld admin ai skills adopt <app-id> <name> --yes
```

`list` shows each Skill's `revision` and `appVersion`. A reset applies only the
app version you name, so content the app publishes after your review is never
applied unseen; the command then fails and you compare again.

## Test a Skill

Test the declaration like other app code. Importing `SKILLS` runs the same
validation as the app start:

```ts
import { expect, test } from "bun:test";
import { SKILLS } from "./skills";

test("ships the counting Skill with its count sheet", () => {
  const counting = SKILLS.find((entry) => entry.name === "inventory-counting");
  expect(counting?.references.map((reference) => reference.path)).toEqual(["references/count-sheets.md"]);
  expect(counting?.instructions).toContain("inventory.location.list");
});
```

Check that every capability ID the Skill names exists and that Assistant can
complete the workflow with a person's normal access.
