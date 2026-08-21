---
id: assistant-workflow
title: Chats & Actions
icon: ti ti-messages
description: Find chats, manage metadata, retry, fork, compact, stop, and handle actions.
order: 110
---

Assistant separates Project chats from general chats in the sidebar. Create a Project from the plus action beside the Projects heading. Projects start expanded with their ten most recently active chats, or select the Project itself to start a chat and search its complete chat history.

## Chat navigation {icon="layout-list"}

:::reference
- **Projects:** The Projects section remains visible even when it is empty. Use its plus action to create a Project with a name and optional instructions.
- **Empty chat:** Choose an optional Project below the centered composer before sending the first message. Starter cards fill an editable request; they never send it automatically.
- **Project page:** Enter the first message in the standard composer, including files when needed. Assistant creates a private Project chat, sends the message, and then opens the normal chat. Search and scroll through existing Project chats below the composer.
- **Project context:** The Project page shows Project instructions, knowledge, images, files, and references. People with write access can add or edit this shared context from that page.
- **General chats:** Up to 15 chats without a Project appear in one **Chats** section below Projects. Use **See all** for the complete history.
- **Search chats:** Use the sidebar search button or the platform shortcut to search saved chats.
- **All Chats:** Project badges identify Project chats in the paginated history. All Chats also provides server-side search and edit actions.
- **Chat context:** On laptop and desktop screens, the compact context stays at the upper right. On smaller screens, use the Context button below the composer to open the same summary in a dialog. A Project chat includes its inherited Project context without Project editing actions.
- **Live file context:** Uploads and generated files update in place. Images open in the image viewer; files open directly in the file browser. Project and chat files share the list and retain their origin.
- **Cloud resources:** Use the composer plus menu to attach a supported Cloud resource without copying its contents into the chat. A chat opened from Mail or another app can begin with one or more resources already attached. Resource links open their owning app in a new tab; every read and Action still checks your current permission there.
- **Sources and references:** A reference shows its current resource title with the resource type underneath when the owning app supplied both. Select a source or reference to review its destination before opening it in a new tab.
- **View all:** The compact summary shows up to three entries per section. Use View all to search complete knowledge, source, and reference lists; browse all files; open all images in the image viewer; or manage the chat's scheduled tasks.
- **Edit or archive:** Use the settings action on a chat to change its name, description, pinning, or archive it.
:::

## Message actions {icon="point"}

:::reference
- **Stop:** Stop aborts the running assistant turn for the open chat.
- **Retry:** Retry reruns a user message and replaces later messages in that chat branch.
- **Fork:** Fork creates a new chat copied through the selected message.
- **Compact:** Use the `/compact` command to summarize the current chat context before continuing.
- **Projects:** Project settings expose shared instructions and context according to your read, write, or admin permission. Project chats remain private.
:::

:::info Approvals and client actions
Some turns can request an approval or a frontend tool result. Answer those prompts in the message list to let the turn continue. Bounded, repeatable Actions may offer **Always approve** in the approval button menu; deletion, external effects, and other consequential Actions continue to ask every time.
:::

## Conversation-aware Assistant {icon="message-forward"}

Assistant can use its live capabilities when your request depends on chat
history. It can search the current chat, find and read another owned chat, and
find structured Cloud resources previously used in either scope.

If you explicitly ask Assistant to tell, ask, notify, forward, or send exact
text to another chat, it can request the `core.ai.chat.message` Action. The approval
prompt shows the target and exact text before anything is queued. Delivered
messages appear in the target history with their source chat; they are not
shown as messages authored by you.
