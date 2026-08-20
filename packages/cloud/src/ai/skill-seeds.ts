import { aiSkills } from "./skills";

const SKILL_CREATOR_INSTRUCTIONS = `# Create and improve Skills

Help the user turn a recurring workflow, specialist knowledge, or a set of instructions into a reusable Assistant Skill. A good Skill changes how Assistant approaches a recognizable task without constraining unrelated work.

## Understand the intended workflow

- First infer the user's intent from the current conversation. Reuse the workflow, corrections, terminology, inputs, and output shape already established instead of interviewing the user again.
- Identify what the Skill should enable, the situations in which it should load, the expected result, and any real dependency or safety boundary.
- Ask only about a missing choice that would materially change discovery, behavior, or output. If the request is already clear, draft the Skill directly.
- Preserve the user's scope. Do not turn one example, preference, or past failure into a universal rule unless the user clearly intends that.

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
- no surprising mutation, permission expansion, or external side effect is implied.

For an existing Skill, read it first and preserve fields the user did not ask to change. Prefer a narrow correction over accumulating rules for every observed example.

## Use Cloud Skill capabilities

Use the current user's permissions and these exact Cloud capabilities:

- \`core.ai.skills.list\` finds Skills the user can read.
- \`core.ai.skill.read\` reads one known Skill before editing it.
- \`core.ai.skill.reference.read\` reads one supporting reference when needed.
- \`core.ai.skill.create\` creates a Skill owned by the current user.
- \`core.ai.skill.update\` updates its name, description, or instructions using the revision returned by the reader.
- \`core.ai.skill.reference.set\` adds or replaces one Markdown reference using the current revision.
- \`core.ai.skill.reference.remove\` removes one reference using the current revision.
- \`core.ai.skill.enabled.set\` changes only the current user's personal enabled state.
- \`core.ai.skill.delete\` permanently deletes a Skill when the current user is an administrator.

Pass the exact current revision to mutations and read again after a revision conflict. Do not claim that a mutation succeeded until its Capability result confirms it.

Creating, changing, and deleting Skills are reviewed mutations. Prepare the concrete content the user requested, then use the Capability review instead of asking for an extra confirmation that duplicates it.

Sharing, access changes, imports, and exports are not available through these capabilities. Say so plainly rather than inventing a tool or bypassing Cloud permissions.`;

export const seedCloudAiSkills = async (): Promise<void> => {
  await aiSkills.seedOnce({
    key: "core:skill-creator",
    name: "skill-creator",
    description:
      "Create and improve reusable Assistant Skills. Use this whenever the user wants to turn instructions or a recurring workflow into a Skill, revise an existing Skill, add supporting information, or enable, disable, or remove a Skill.",
    instructions: SKILL_CREATOR_INSTRUCTIONS,
  });
};
