# Cloud assistant chat

The Cloud adapter connects AI sessions, turns, tools, attachments, retries, forks, and usage snapshots to `Chat` from `@k2b/ui`.

## Use Cloud assistant chat

Use the Cloud adapter only for the platform AI protocol. Standalone Solid applications and other backends use `Chat` directly.

## Import

```tsx
import {
  AiChatActionsProvider,
  aiChatAttachments,
  aiChatModelOptions,
  aiComposerSendInput,
  createAiChatTimeline,
} from "@k2b/cloud/ai/ui";
import { Chat } from "@k2b/ui";
```

## Cloud ownership

- `createAiChatTimeline` reactively maps persisted messages and the active turn to `ChatTimelineItem[]`.
- `AiChatActionsProvider` binds approval, frontend-tool, retry, fork, message-feedback, and file behavior to rich Cloud blocks.
- `aiChatModelOptions` and `aiChatAttachments` map Cloud records into portable values.
- `aiComposerSendInput` maps `ChatSubmitInput` back to the Cloud controller input.

The application still owns the current controller and mutation callbacks. Cloud persistence, streaming, tools, approvals, and files remain outside `@k2b/ui`.

## Accessibility

`Chat` owns common keyboard, focus, status, and accessible-name behavior. Cloud renderers preserve visible status and accessible names for domain-specific tool blocks.

## Runtime

Persisted messages, live turns, attachments, retries, tools, feedback, and mutations require the Cloud AI controller and authenticated platform routes. Message feedback belongs to the private conversation owner and never enters model context.

## Example

```tsx
const Conversation = () => {
  const items = createAiChatTimeline({
    messages: chat.messages,
    activeTurn: chat.activeTurn,
  });

  return (
    <Chat>
      <Chat.Timeline
        items={items()}
        loading={chat.loadingConversation()}
        hasMore={chat.hasMoreHistory()}
        onLoadOlder={chat.loadOlderMessages}
      />
      <Chat.Composer
        value={draft()}
        onValueChange={setDraft}
        state={chat.runStatus() === "stopping" ? "stopping" : chat.running() ? "running" : "idle"}
        models={aiChatModelOptions(availableModels())}
        selectedModelId={selectedModelId()}
        onModelChange={setSelectedModelId}
        attachments={aiChatAttachments(attachments())}
        onSubmit={(input) =>
          input.intent === "steer"
            ? chat.steer(input.text)
            : chat.send(aiComposerSendInput(input))
        }
        onStop={chat.abort}
        contextUsage={{
          usage: latestUsage(),
          loopUsage: latestLoopUsage(),
          contextWindow: selectedContextWindow(),
          modelLabel: selectedModelLabel(),
        }}
      />
    </Chat>
  );
};

<AiChatActionsProvider actions={messageActions}>
  <Conversation />
</AiChatActionsProvider>;
```
