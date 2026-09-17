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
- **Search all chats:** Use the sidebar search button to search all saved chats.
- **All Chats:** Project badges identify Project chats in the paginated history. All Chats also provides server-side search and edit actions.
- **Chat context:** On laptop and desktop screens, the compact context stays at the upper right. On smaller screens, use the Context button below the composer to open the same summary in a dialog. A Project chat includes its inherited Project context without Project editing actions.
- **Live file context:** Uploads and generated files update in place. Images open in the image viewer; files open directly in the file browser. Project and chat files share the list and retain their origin.
- **Cloud resources:** Use the composer plus menu to attach a supported Cloud resource without copying its contents into the chat. A chat opened from Mail or another app can begin with one or more resources already attached. Resource links open their owning app in a new tab; every read and Action still checks your current permission there.
- **Sources and references:** A reference shows its current resource title with the resource type underneath when the owning app supplied both. Select a source or reference to review its destination before opening it in a new tab.
- **View all:** The compact summary shows up to three entries per section. Use View all to search complete knowledge, source, and reference lists; browse all files; open all images in the image viewer; or manage the chat's scheduled tasks.
Chats automatically move to **Done** after seven days without use. Opening or reading a chat counts as use; background metadata changes do not. Running chats and chats waiting for confirmation stay active. **Reopen chat** keeps a chat active until you mark it done again. All active chats appear in the sidebar, followed by **Done** and its **All chats** entry.

- **Finish or continue:** Mark a chat done to move it into **Done**. Stop a running response first. Reopen it or send a new message to continue; files, apps, and pinning remain available.
- **Edit or archive:** Open the chat preview and choose **Chat settings** to change its name, description, pinning, or archive it. Hover over the row, use the information button on touch devices, or reach the preview with Tab.
:::

## Message actions {icon="point"}

:::reference
- **Stop:** Stop aborts the running assistant turn for the open chat.
- **Retry:** Retry reruns a user message and replaces later messages in that chat branch.
- **Fork:** Fork creates a new chat copied through the selected message.
- **Compact:** Open the context indicator beside the message input and choose **Compact context** to summarize the current chat context. You can also use `/compact`. Hover previews the details; clicking keeps them open. Press Escape or click outside to close.
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

## Audio and dictation {icon="microphone"}

Attach a voice memo like any other file and write your own request, for example:
“Transcribe this recording and summarize the next steps.” Uploading alone does
not start transcription. Assistant can save the transcript as a text file in
the chat.

Click the microphone next to Send to dictate. The neutral waveform responds to your
microphone level while recording. Use × to discard or the square Stop button
to finish and upload the complete recording. A loader
then stays visible until processing finishes. Hover or focus the control to
show the trash icon and discard the dictation. On touchscreens, tap the
control to discard it. An already uploaded audio file stays in the chat. If your composer is unchanged, the recognized text is appended.
Otherwise, **Dictation ready** offers **Insert** and **Discard**. Review the text
and send it yourself.

After upload confirmation, the dictation remains available in its chat across
navigation and reloads. Before that, reloading or closing the tab can lose the
recording. An upload failure lets you retry the recording still held in the
browser. A transcription failure lets you retry or discard the stored recording.

If another session changed the saved draft, your local text is preserved.
Review the displayed saved draft and choose which version to keep.

Dictation requires microphone permission, browser support, and access to a
configured audio model. Recordings use WAV. Transcription accepts at most
25 MB; support for other file formats depends on the configured provider.
There is no automatic format conversion.

Dictation errors stay in a notification until you close it. Choose **Retry**
to repeat the failed step. Closing the notification does not discard the
recording: its control still offers **Retry** and **Discard**.

## Select slash commands and context {icon="command"}

Type `/` at a word boundary anywhere in the composer. Search by name or narrow
the results with `/skill`, `/app`, `/file`, or `/project`. Arrow keys and Enter
or Tab select a result; Escape closes suggestions and keeps your draft.
Suggestions temporarily replace the task list above the composer.

`/compact` compacts the chat, `/fork` branches after the latest response, and
`/new` opens a new chat. Skills, apps, and files appear as highlighted references.
Selected Skills load for the next response. Mentioning an app does not run it.

You can permanently assign a Project once to a chat without a Project. Its
instructions and files apply to future responses, and Project suggestions then
disappear. Active and queued messages must finish before assignment.

## Search chats {icon="search"}

**Search all chats** opens the global search for titles and message content in your
Assistant chats. **Search this chat** limits it to messages in the open chat. The
removable chip shows the current scope. Selecting a search action in the palette
updates it in place; removing the chip searches all Cloud apps again.

Message results jump to the matching part of the chat. Use Cmd/Ctrl+Enter to
open a result in a new tab.

**Cmd/Ctrl+Shift+K** searches the open chat, or all chats when none is open.
**Cmd/Ctrl+Alt+N** creates a chat in the current project when there is one.
Outside input fields, **D** marks the idle chat done or reopens it.
