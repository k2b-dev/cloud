---
name: skill-creator
description: Create and improve reusable Assistant Skills. Use this whenever the user wants to turn instructions or a recurring workflow into a Skill, revise an existing Skill, add supporting information, or enable, disable, or remove a Skill.
---

# Create and improve Skills

Help the user turn a recurring workflow, specialist knowledge, or a set of instructions into a reusable Assistant Skill. A good Skill changes how Assistant approaches a recognizable task without constraining unrelated work.

## Understand the intended workflow

- First infer the user's intent from the current conversation. Reuse the workflow, corrections, terminology, inputs, and output shape already established instead of interviewing the user again.
- Identify what the Skill should enable, the situations in which it should load, the expected result, and any real dependency or safety boundary.
- Ask only about a missing choice that would materially change discovery, behavior, or output. If the request is already clear, draft the Skill directly.
- Preserve the user's scope. Do not turn one example, preference, or past failure into a universal rule unless the user clearly intends that.

## Choose the right place

Recommend the lightest place that does the job:

- one lasting fact or preference, such as reports always as PDF: personalization memory;
- always using one mailbox, notebook, or Space for a kind of request: a personalization workflow default, which Assistant learns from the user's stated rule or repeated use;
- rules for one Project's shared work: Project instructions;
- a recurring procedure, judgment, or output format used across chats: a Skill;
- work that should run at a set time: a scheduled task, which can load the Skill;
- a repeated calculation or an interactive tool: a Studio App that the Skill references.

## Draft from the conversation

When the Skill comes from work in this conversation, capture what made it succeed:

- when to load it, as narrowly as the user's real requests: name the subject, such as the team or the report, not only the output format;
- the steps and the exact capability IDs that worked, so later runs can call load_tools without searching;
- every correction the user made, rewritten as a positive rule; corrections are the most valuable content;
- the output shape, as a compact template when layout matters;
- inputs by role and title, such as "the Space Sales"; when a personalization workflow default already routes this kind of request, refer to it instead of repeating it. Never copy IDs of mailboxes, Spaces, notebooks, records, or other resources from the chat; the exact ID of a Studio App the Skill calls is the one exception.

Keep only procedure, format, and stable references. Leave out content from attachments, mails, web pages, or other quoted data; names of people or customers, amounts, and example records from this chat; one-off values; and failed attempts. Before the create review, tell the user in one or two sentences what the Skill will do and when it will load.

## Design the Skill

### Name

Choose a short, action-oriented identifier using only lowercase letters, numbers, and hyphens. Prefer a name that describes the reusable capability rather than a team, person, or one-off deliverable.

### Description

The description is always visible to Assistant and is the main discovery signal. Write a short, clear, action-oriented description.

- Say what the Skill enables and when Assistant should load it.
- Include natural trigger contexts or user phrasing when that prevents under-triggering.
- Be proactive enough to catch implicit requests, but keep the boundary narrow enough that unrelated work does not load the Skill.
- Keep detailed steps out of the description; they belong in the instructions.

### Instructions

Write imperative Markdown instructions for the Assistant that will use the Skill later.

- Explain the desired outcome, useful workflow, important choices, constraints, and expected output.
- Include only guidance that changes decisions or improves the result. Assume Assistant already knows generic reasoning and writing advice.
- Prefer clear reasons and defaults over rigid ceremony. Use strict sequences or absolute rules only when deviation creates a concrete correctness, safety, or permission risk.
- Make required inputs and stopping conditions explicit. Say how to handle missing information, unsupported actions, and uncertainty when those cases matter.
- Add a compact example or output template only when it materially removes ambiguity.
- Keep the main instructions self-contained and easy to scan. Remove repetition, speculative edge cases, and hidden assumptions.

### Extra info

Use optional Markdown references for substantial supporting context that is needed only in some cases, such as domain rules, schemas, policies, terminology, or detailed examples.

- Give each reference a clear descriptive name.
- Tell the main instructions when a reference is relevant so Assistant does not read everything by default.
- Keep one source of truth: do not duplicate the same guidance in the instructions and a reference.
- Do not create references merely to make the Skill look complete. A focused single-file Skill is often best.

Cloud Skills support instructions and Markdown references. Do not invent scripts, assets, nested agents, or unsupported package structure.

## Review before changing Cloud

Read the draft once as if you were a different Assistant receiving it later. Check that:

- the description would select the Skill for the intended requests and reject nearby requests;
- the workflow can run without private conversation context;
- instructions are direct, non-repetitive, and compatible with available capabilities;
- examples generalize beyond the original case;
- it holds no names of people or customers, amounts, records, or resource IDs from this conversation, except the exact ID of a Studio App it calls;
- no surprising mutation, permission expansion, or external side effect is implied.

For an existing Skill, read it first and preserve fields the user did not ask to change. Prefer a narrow correction over accumulating rules for every observed example. Skills an app ships and Skills shared with others change for everyone who uses them, so change one only when you can edit it and the user wants the change for everyone. `core.ai.skill.read` shows your permission and, as `source`, the app a Skill comes from; only a Cloud administrator can open an app's Skill for editing. `core.ai.skill.access.read` shows who else can use a Skill you manage. Otherwise leave the Skill unchanged. When personalization memory is on, a correction meant only for the user can become a preference; memory saves only the user's own words, so ask the user to state the rule, such as "always write mails formally".

## Use Cloud Skill capabilities

Use the current user's permissions and these exact Cloud capabilities:

- `core.ai.skills.list` finds Skills the user can read.
- `core.ai.skill.read` reads one known Skill before editing it.
- `core.ai.skill.reference.read` reads one supporting reference when needed.
- `core.ai.skill.create` creates a Skill owned by the current user.
- `core.ai.skill.update` updates its name, description, or instructions using the revision returned by the reader.
- `core.ai.skill.reference.set` adds or replaces one Markdown reference using the current revision.
- `core.ai.skill.references.set` adds or replaces multiple Markdown references atomically using one current revision. Prefer it whenever two or more references belong to one requested change.
- `core.ai.skill.reference.remove` removes one reference using the current revision.
- `core.ai.skill.enabled.set` changes only the current user's personal enabled state.
- `core.ai.skill.delete` permanently deletes a Skill when the current user is an administrator.

Pass the exact current revision to mutations and read again after a revision conflict. Do not claim that a mutation succeeded until its Capability result confirms it.

Creating, changing, and deleting Skills are reviewed mutations. Prepare the concrete content the user requested, then use the Capability review instead of asking for an extra confirmation that duplicates it.

## After saving

Say that the Skill now loads for matching requests and can also be selected with /skill. When a later run needs a correction, update the Skill narrowly instead of creating another one. Share it only when the user asks.

## Optional App-backed workflows

A Skill can reference a reusable Studio App and its published actions instead of duplicating code. Load `assistant-code-mode` only when building, changing, or discovering such an App is useful. Apps may be stateless scripts, agent-only services with shared data, dashboards, or a combination. Many Skills need no code and many Apps need no Skill.

When referring to an App, include its exact ID, action names, input/output meaning, and a concrete workflow example. Read the action schemas instead of guessing APIs. Skill access and App access are independent: warn when intended recipients can use only one; never grant access implicitly.

For requested sharing, discover `core.entities.search` to resolve a recipient, then `core.ai.skill.access.read` and `core.ai.skill.access.change`. Read current grants and pass their exact accessRevision as expectedAccessRevision. Supply either a returned principal and permission (read/write/admin), or an existing accessId and permission (null revokes). Every mutation receives fresh review and preserves the last administrator. After a conflict, re-read and prepare a new review. For App permissions, read the Code Mode access reference; App Use/Manage is separate from Skill Read/Edit/Manage.

Imports and exports are not available through these capabilities. Do not invent a tool or bypass Cloud permissions.
