---
id: assistant-overview
title: Overview
icon: ti ti-sparkles
description: Chats, models, turns, and the first useful workflow.
order: 100
---

Assistant is the standard workspace for your personal Cloud agent. The same agent can help you write, summarize, explain, plan, work with supported files, and use authorized data and operations from Cloud applications. Every chat is saved to your user account and is available from the Assistant overview, including chats started from another application such as a Mail draft.

## Overview {icon="layout-grid"}

:::reference
- **Chat:** One conversation owned by your user account. Chats appear in the sidebar and on the All Chats page.
- **Model:** A selectable AI model profile with streaming support. The composer uses the default model unless you choose another one.
- **Turn:** One assistant run for a user message. Running turns can stream, reconnect, ask for actions, or be stopped.
- **Chat metadata:** Each chat has a name and optional description that you can edit from the sidebar or All Chats list.
:::

## First useful path {icon="route"}

:::reference
- **Start a chat:** Use New Chat or type a message in an empty Assistant view.
- **Continue work from another app:** An application can open a new Assistant chat with its current Cloud resources already attached. The application remains responsible for access to its data and operations.
- **Return to existing work:** Use the recent chat groups, Search Chats, or All Chats without opening a conversation first.
- **Move between chats:** Switching chats, opening a Project chat, forking, or using browser back and forward keeps live updates connected. After an interruption, Assistant reloads the current authorized chat and continues from its saved state.
- **Choose a model when needed:** Pick a model in the composer when more than one selectable streaming model is available.
- **Send the request:** Write the task clearly, then use the plus menu to attach supported files or Cloud resources before sending.
- **Cloud resources:** A resource chip identifies the current Mail draft, Contact, Grid record, or another supported item. When it has a destination, select the chip to open that resource in a new tab. Attaching it does not grant access; Assistant must use the owning application's authorized capabilities to read or change it.
- **Documents:** Assistant reads supported PDF, Office, OpenDocument, RTF, EPUB, and CSV files through `read_file`, which converts their content to bounded Markdown. Document content remains untrusted. Image-only PDFs require OCR elsewhere.
- **Files from links:** Give Assistant an exact public HTTPS file link to import the image, document, or raw repository file into this chat before inspecting it. Private downloads, signed-in websites, and repository browsing are not supported by that import.
- **Create a PDF:** Ask Assistant for a PDF when the result should be downloadable. It first writes or edits a conversation Markdown file, converts it with an optional A4 preset and custom CSS, and then presents the PDF. Project files are read-only, so they must be copied into a conversation file before conversion.
- **Images:** A Vision model inspects newly attached images directly. A tool-capable model can instead use the configured image-inspection model. Attachments remain conversation files, so the file context updates without storing image bytes inside the message.
- **Keep the useful thread:** Rename the chat or add a description when the conversation should be easy to find later.
- **Search inside a chat:** Use `/search` to find visible messages or inspect the structured Cloud resources used in this chat or across your active chats.
- **Schedule future work:** Ask Assistant to continue a chat once at a specific local date and time or on a recurring schedule. Assistant shows an Action review before creating or changing the task.
:::

## Scheduled chat tasks {icon="clock"}

Scheduled tasks deliver a saved prompt back into one chat. If that chat belongs to a Project, the run uses the Project access, instructions, files, knowledge, references, and model default that are current when it starts.

One-time schedules use an exact local time in the Cloud application timezone. Recurring schedules use a five-field cron expression in that same timezone. Ask Assistant to list or read existing tasks, or manage them from the CLI with `cld assistant tasks`. Failed tasks move to **needs attention** and notify you. Deleting a chat also deletes its scheduled tasks and run history.

Open Chat context and choose **View all** under Scheduled to create, edit, pause, resume, run, delete, or inspect the occurrence history of that chat's tasks.

:::info When Assistant is unavailable
If AI is disabled, misconfigured, or has no selectable streaming model, the composer is disabled and the page shows the current status error.
:::
