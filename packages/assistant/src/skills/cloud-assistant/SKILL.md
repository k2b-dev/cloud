---
name: cloud-assistant
description: 'Use for work involving Cloud Assistant itself: finding or reading earlier conversations, recovering resources used in chats, messaging another conversation, or creating and managing reminders and recurring scheduled chat work. Also use when a request refers to earlier work, such as "like last time", "as last week", or "the report you made me".'
---

# Work with Cloud Assistant

Use these defaults unless the user asks otherwise or a more specific loaded Skill overrides them.

## Capabilities

- Conversations: `core.ai.chats.search`, `core.ai.chat.read`, `core.ai.chat.search`, `core.ai.chat.resources`, and `core.ai.chats.resources`.
- Messaging: `core.ai.chat.message`.


Load only the needed capabilities and reuse returned typed IDs unchanged.

## Normal flows

- The runtime Chat ID identifies the current conversation. Use `core.ai.chat.search` for earlier content in it. For another conversation, use `core.ai.chats.search`, then `core.ai.chat.read` or `core.ai.chat.search` with the returned ID.
- Use `core.ai.chat.resources` for resources from one known conversation and `core.ai.chats.resources` to search across conversations. Read a returned resource through its owning app rather than guessing its contents.
- Before `core.ai.chat.message`, identify the exact target and message. Report queued or delivered status accurately and do not claim the target completed the requested work.
- For one-time reminders, recurring background work, or changing and repairing a scheduled task, load the `scheduled-tasks` Skill.
