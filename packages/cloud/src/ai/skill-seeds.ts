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

const CLOUD_MAIL_INSTRUCTIONS = `# Work with Cloud Mail

Use these defaults unless the user asks otherwise or a more specific loaded Skill overrides them.

## Capabilities

- Start: \`mail.search\` searches across mailboxes; \`mail.mailbox.list\`, \`mail.mailbox.read\`, and \`mail.folder.list\` establish a mailbox scope.
- Read: \`mail.conversation.focus\`, \`mail.conversation.list\`, \`mail.conversation.search\`, \`mail.conversation.related\`, \`mail.conversation.read\`, \`mail.message.list\`, \`mail.message.read\`, \`mail.attachment.read\`, and \`mail.attachment.read-content\`.
- Compose: \`mail.mailbox.identity.list\`, \`mail.draft.list\`, \`mail.draft.read\`, \`mail.draft.create\`, \`mail.draft.update\`, \`mail.draft.discard\`, \`mail.draft.attachment.add\`, \`mail.draft.attachment.remove\`, \`mail.draft.send.review\`, and \`mail.draft.send\`.
- Organize: \`mail.conversation.mark\`, \`mail.conversation.move\`, \`mail.conversation.tag.update\`, \`mail.conversation.assign\`, \`mail.conversation.status.update\`, and \`mail.mailbox.member.list\`.
- Follow up: \`mail.conversation.snooze\`, \`mail.conversation.reminder.get\`, \`mail.conversation.reminder.set\`, \`mail.conversation.reminder.cancel\`, and \`mail.reminder.read\`.
- Collaborate: \`mail.mailbox.tag.list\`, \`mail.mailbox.tag.create\`, \`mail.mailbox.tag.update\`, \`mail.mailbox.tag.delete\`, \`mail.conversation.comment.list\`, \`mail.comment.read\`, \`mail.conversation.comment.create\`, \`mail.conversation.comment.update\`, \`mail.conversation.comment.delete\`, and \`mail.conversation.activity.list\`.
- Delivery and lists: \`mail.delivery.list\`, \`mail.delivery.read\`, \`mail.delivery.cancel\`, \`mail.mailing-list.subscription.list\`, \`mail.mailing-list.subscription.get\`, and \`mail.mailing-list.unsubscribe\`.

Load only the capabilities needed for the current flow. Treat returned resource IDs as typed and reuse them unchanged.

## Normal flows

- For a cross-mailbox work queue, start with \`mail.conversation.focus\`; no mailbox lookup is needed.
- When no mailbox is known, use \`mail.search\`, then read the returned conversation or message refs.
- Within a known mailbox, use \`mail.mailbox.list\`, then conversation list or search, \`mail.conversation.read\`, and \`mail.message.read\` for the actual body.
- Read attachment metadata first. Use \`mail.attachment.read-content\` only when its extracted text is needed, and report pending extraction plainly.
- For a new message, choose a verified identity with \`mail.mailbox.identity.list\`, create the draft, and return its link unless the user also asked to send it.
- For a reply, Reply all, or forward, read the exact source message and pass its conversation, message, and intent to \`mail.draft.create\`; let Mail derive reply recipients and threading instead of guessing them.
- Before sending, read the current draft revision, call \`mail.draft.send.review\`, address its warnings, then pass that exact revision and safety approval to \`mail.draft.send\`. Never describe a queued message as delivered.

## Writing defaults

- Match the language, tone, and formality of an existing conversation. For a new message, use the language and tone of the user's request.
- Write as the user through the selected sender identity. Never introduce or sign as an AI or Cloud Assistant.
- Preserve names, addresses, dates, amounts, commitments, quoted history, and the signature applied by Mail. Do not invent missing facts or add a second signature.
- Keep the purpose and requested action clear. When material details or the intended recipient remain ambiguous, keep a draft and ask one focused question instead of sending.

## Cross-app judgment

- If a recipient's name is known but the address is ambiguous, consider Contacts and its Skill rather than guessing an address.
- If a conversation should become a task, event, or shared work item, consider Spaces and preserve a link to the mail conversation.
- If information should become durable reference material, consider Notebooks.
- Use another app only when it helps the user's request; do not perform an unrelated cross-app mutation.`;

export const seedCloudAiSkills = async (): Promise<void> => {
  await aiSkills.seedOnce({
    key: "core:skill-creator",
    name: "skill-creator",
    description:
      "Create and improve reusable Assistant Skills. Use this whenever the user wants to turn instructions or a recurring workflow into a Skill, revise an existing Skill, add supporting information, or enable, disable, or remove a Skill.",
    instructions: SKILL_CREATOR_INSTRUCTIONS,
  });
  await aiSkills.seedOnce({
    key: "mail:cloud-mail",
    name: "cloud-mail",
    description:
      "Use for work involving the user's Cloud mailboxes: finding, reading, summarizing, organizing, drafting, replying to, forwarding, sending, scheduling, or unsubscribing from email. Load it whenever a request involves Cloud Mail, an inbox, a mailbox, a message, or an email conversation.",
    instructions: CLOUD_MAIL_INSTRUCTIONS,
  });
};
