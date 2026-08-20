---
id: assistant-guidance
title: Better results
icon: ti ti-bulb
description: Give useful context, work with files, personalize responses, and recover when a run goes wrong.
order: 120
---

Assistant works best when the request states the outcome, the relevant context, and any limits that matter. You do not need a special prompt format.

## Write a useful request {icon="pencil"}

:::steps
1. **Name the outcome:** Say what you want to receive, such as a summary, plan, explanation, draft, comparison, or code change.
2. **Include the source material:** Paste the relevant text or attach the files offered by the composer. Mention which parts matter most.
3. **State important constraints:** Include the audience, language, length, format, deadline, or things that must not change.
4. **Ask for a check:** For important work, ask Assistant to identify assumptions, uncertainties, or missing information before relying on the answer.
:::

## Keep context under control {icon="point"}

- **Continue the same chat** when the next request depends on earlier messages.
- **Start a new chat** when the task is unrelated or the old context could be misleading.
- **Fork from a message** when you want to explore another direction without replacing the useful branch.
- **Use `/compact`** when a long chat should continue with a shorter summary of its context.
- **Add a chat description** when future-you needs to know why the conversation matters.

## Personalization {icon="point"}

- **Personalization** stores separate facts and preferences you can review, edit, pin, or forget. Manually added entries start pinned, and Assistant keeps a small relevant set in context instead of loading an unbounded history.
- **Learn from chats** lets Assistant save explicitly stated durable facts and preferences after an idle chat. Learning reads only your own text, not attached resources, files, tool results, or Assistant replies, and it never silently deletes entries.
- **System prompt** shows the complete prompt a new chat would receive, including active personalization and organization rules.
- **Approvals** lists Actions you accepted with **Always approve**. Revoke an entry there whenever Assistant should ask again.
- **Chat context** is still the best place for project-specific facts, source material, and one-off constraints.

## Shared Skills {icon="sparkles"}

Open **Assistant settings > Skills** to create, import, edit, export, or share reusable Assistant workflows. A Skill keeps its instructions in `SKILL.md` and may include Markdown reference files.

You can also ask Assistant to create or improve a Skill. Cloud initially provides **Skill Creator** to every signed-in user. It guides the draft and uses reviewed Skill-management capabilities with your current permissions. Like any shared Skill, it can be disabled for yourself; administrators can grant access, edit it, or delete it.

### Create a Skill that loads at the right time

:::steps
1. **Choose a short, action-oriented name:** Use lowercase letters, numbers, and hyphens, such as `weekly-status`.
2. **Write a direct description:** Say what Assistant should do and when it should use the Skill. Keep it specific enough to distinguish the Skill from similar workflows. For example: `Create weekly status reports from recent work. Use when asked for progress updates.`
3. **Add only useful instructions:** Define the expected outcome, important constraints, and workflow. Omit generic advice Assistant already knows.
4. **Move supporting detail to Extra info:** Add policies, schemas, examples, or background material that Assistant needs only for some requests. Keep essential instructions in the Skill itself.
5. **Try realistic requests:** Check that Assistant loads the Skill for relevant requests and ignores it otherwise. Refine the description when selection is too broad or too narrow.
:::

- Import a bare `SKILL.md`, or use a ZIP when the Skill has references. Scripts and assets are not supported.
- Use Cloud access to share a Skill. Readers can use and export it, writers can edit it, and admins can also manage access or delete it.
- Skills you can read start enabled for you. Turn off **Enabled for me** when you do not want Assistant to use a shared Skill; this does not change anyone else's access.
- Assistant sees the names and descriptions of your enabled Skills. It loads a relevant Skill before applying its instructions and reads references only when needed.
- A Skill loaded for an in-progress turn stays on that revision. New turns use later edits, while revoked access takes effect immediately.

:::warning Review consequential output
Treat generated facts, calculations, external actions, and changes to important data as proposals until you have checked them. Approval prompts exist so you can review an action before the turn continues.
:::

## If a response stalls or misses the task {icon="point"}

- Stop a run that is clearly heading in the wrong direction, then send a shorter correction.
- Retry when the request was sound but the run failed or produced an incomplete response.
- Check the selected model and the status shown by the composer when no response starts.
- Split a large request into a small first result and a follow-up instead of repeating an overloaded prompt.
