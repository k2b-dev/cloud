---
id: assistant-workflow
title: Chats & Actions
icon: ti ti-messages
description: Find chats, manage metadata, retry, continue in a new chat, compact, stop, and handle actions.
order: 110
---

The sidebar lists your active chats as plain rows: pinned chats first, then by the day you last used them (**Today**, **Yesterday**, **Previous 7 days**, **Previous 30 days**, **Older**). Open **Projects** in the sidebar footer to choose, search, or create a Project, and select a Project to start a chat in it or search its complete chat history.

## Chat navigation {icon="layout-list"}

:::reference
- **Chat rows:** Each row shows the chat's title. One icon at the row's end marks a chat that is running, waiting for you, failed, has a new response, or has an active schedule; its tooltip names the state.
- **Projects:** Use the plus action in the Projects popup to create a Project with a name and optional instructions.
- **New chat:** Opens an empty chat. When the open chat is still empty, Assistant keeps it instead of creating another one, unless it belongs to a Project, was opened by another app, has a name or description you gave it, or is pinned, done, or archived.
- **Empty chat:** Choose an optional Project below the centered composer before sending the first message. Starter cards fill an editable request; they never send it automatically.
- **Project page:** Enter the first message in the standard composer, including files when needed. Assistant creates a private Project chat, sends the message, and then opens the normal chat. Search and scroll through existing Project chats below the composer.
- **Project context:** The Project page shows Project instructions, knowledge, images, files, and references. People with write access can add or edit this shared context from that page.
- **Search all chats:** Use the sidebar search button to search all saved chats.
- **All Chats:** Project badges identify Project chats in the paginated history. Search titles and messages, and filter with one menu: all chats, new responses, running, waiting for you, failed, done, or archived.
- **In this chat:** The sidebar at the right of a chat shows what the chat holds. On large screens it is open; close it with the button in its header and it stays closed until you open it again with the button at the upper right of the chat. On narrower windows that button opens it over the edge of the chat, and on a phone as a sheet that Back closes.
- **Results first:** Files, Studio apps, and visualizations the assistant created for you are listed first, the newest with the sentence the assistant gave them. Open or download them directly, or select a title to jump to the place in the chat where it was delivered. Older results are grouped by day and, after a week, by month.
- **Nothing moves while you read:** While the pointer or focus is in the sidebar, new results only raise **New · N** in the heading, and other changes show **Update**. They appear when you leave the sidebar or select the control. On a touch screen, the sidebar holds still until you touch outside it.
- **Your files:** Your uploads and voice recordings. Images open in the image viewer, other files in the workspace.
- **Sources:** Web pages the assistant read, every web search with what it searched for, and the Cloud items a tool read, one row per request. Select a source to review its destination before opening it in a new tab.
- **Working files:** Intermediate steps the assistant keeps in the chat folder `temp/`, grouped by what they were for. Once the chat uses more than 70 % of its storage, the row shows how much. You can delete a whole group after confirming; results stored in it are named there, because they are deleted too.
- **Context:** The Project with its instructions, knowledge, files, and references, the Skills the chat used, what was remembered from it, its scheduled tasks, and Secrets. A Project chat includes its inherited Project context without Project editing actions.
- **Search:** Use the search button in the sidebar's header to find results, files, and sources in this chat. Escape closes the search.
- **Delete chat files:** Point at an upload, voice recording, or working file, or reach it with Tab, then select the trash icon at the right; for a result, use its menu. The icon is always visible on touch devices. After you confirm, Assistant removes the file from this chat and closes its open tab. Earlier messages keep their text, but their links to the file no longer open it. Project files are managed on the Project page.
- **Cloud resources:** Use the composer plus menu to attach a supported Cloud resource without copying its contents into the chat. A chat opened from Mail or another app can begin with one or more resources already attached. Resource links open their owning app in a new tab; every read and Action still checks your current permission there.
Chats automatically move to **Done** after seven days without use. Sending a message, a run, or reopening a chat counts as use; opening or reading a chat only marks it as read, and background metadata changes do not count either. Running chats and chats waiting for confirmation stay active. **Reopen chat** keeps a chat active until you mark it done again. All active chats appear in the sidebar, followed by **Done** and its **All chats** entry.

- **Finish or continue:** Mark a chat done to move it into **Done**. Stop a running response first. Reopen it or send a new message to continue; files, apps, and pinning remain available.
- **Edit or archive:** Open the chat preview and choose **Chat settings** to change its name, description, pinning, or archive it. Hover over the row, use the information button on touch devices, or reach the preview with Tab.
:::

## Message actions {icon="point"}

:::reference
- **Stop:** Stop aborts the running assistant turn for the open chat.
- **Retry:** Retry reruns a user message and replaces later messages in that chat branch.
- **Continue in a new chat:** Creates a new chat copied through the selected answer.
- **Response details:** Shows the model, time, and token usage of one answer.
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
