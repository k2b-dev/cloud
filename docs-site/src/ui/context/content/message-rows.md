# Message rows

`MessageRow` shows one message in a conversation with many people. Others'
messages sit on the left with a round avatar, the reader's own on the right in
the accent tint. Messages by the same author within five minutes form a group:
only the first shows the avatar, name, and time. `MessageSystemRow` is a quiet,
centered line for something that happened, such as a person joining.

Every part of a row has its final height when it mounts, so the rows compose
with [`VirtualFeed`](/en/ui/content/virtual-feed) and the feed keeps its
positions. The application owns the messages, their order, sending, read
state, and every action. The rows own layout, the safe text rendering, the
send state, and the action toolbar.

## Import

```tsx
import {
  MessageRow,
  MessageSystemRow,
  startsMessageGroup,
  type MessageRowAction,
  type MessageRowAuthor,
  type MessageRowProps,
  type MessageRowStatus,
  type MessageSystemRowProps,
} from "@k2b/ui";
```

## Use MessageRow

Pass the `author` (`name`, and an `avatar` URL or an `icon` when there is one),
the `text` as Markdown, and the visible `time`, formatted by the application
so that server and browser render the same text. `dateTime` adds the
machine-readable time. Set `own` for the reader's own messages; they show no
avatar and no name.

Without a picture, the avatar shows initials on a tint that the name decides,
the same `Avatar` that the rest of `@k2b/ui` uses, so the same name has the
same color everywhere. Pass the display name that the application shows for
the person elsewhere.

### Groups

`groupStart` decides whether a row starts a group with avatar, name, `badge`,
and time. A continuation shows its text only; screen readers still hear the
author and the time. `startsMessageGroup(entry, previous)` returns `true` when
there is no previous message, either one is a system row, the author changes,
or more than five minutes passed. Also start a group where the feed shows a
separator, such as a new day. A row depends only on the row before it, so
appending a message never changes an existing row.

`badge` is shown next to the name, for example the kind of account. Keep it
one line high.

### Text

The text is a safe subset of Markdown, rendered like `MarkdownView` with HTML
turned off:

- Raw HTML shows as text.
- Links must be absolute and use `https`, `http`, or `mailto`; any other
  link, such as `javascript:` or a relative `/settings`, shows as its text. A
  relative link would lead somewhere else on every page that shows the
  conversation. Links open in a new tab with `rel="noopener noreferrer"`.
- Images show their description and load nothing.
- A single line break is kept, as people expect in messages.
- Code blocks show their language and a "Copy" button above the code. Long
  lines scroll inside the block, not the page.

A long message mounts collapsed to ten lines with "Show more"; its last two
lines fade out. Whether it collapses is decided from the rendered text alone,
not from the width: it collapses when it takes more than 14 lines. A line of
text counts as one line for every started 100 visible characters, every line
of a code block counts as one, blank ones included, and link destinations and
reference definitions count as nothing. That way the row never changes height
after it mounts, and a collapsed message always hides some of its text.
"Show more" and "Show less" change the height only when the reader asks, or
when keyboard focus reaches a link or code block in the hidden or faded part.
A row that unmounts while the feed scrolls, or whose item is replaced, mounts
collapsed again.

### Send state and read line

`status` adds a line of fixed height below the message:

- `"pending"`: a clock and "Sending";
- `"sent"`: a check;
- `"failed"`: "Not sent" and, with `onRetry`, a "Retry" button.

`receipt` replaces the check with the application's text, such as "Read by
Nora, Tobias"; it ends in an ellipsis when it is too long. The line exists
while `status` or `receipt` is set. Set `status` on every own message from the
start, so the line is reserved and a send that completes, fails, or is read
never moves the rows below it.

The row shows the send state but does not announce it: a send can fail while
its row is scrolled away and not mounted. Announce a failure where the
application learns of it, for example with `announce` from `@k2b/ui`:

```tsx
const send = async (message: ChatMessage) => {
  try {
    await postMessage(message);
    update(message.id, { status: "sent" });
  } catch {
    update(message.id, { status: "failed" });
    announce(t().messageNotSent);
  }
};
```

### Actions

`actions` are icon buttons with a label each. They appear as a small toolbar
over the top corner of the row while a mouse or pen rests on it or focus is
inside it, so they never move anything. On a phone or tablet, the first tap
on a message focuses its row and shows them without pressing the action under
the finger. Keep the list short, about two to four actions.

### System rows

`MessageSystemRow` takes the text as children, an optional `icon`, and an
optional `time` with `dateTime`. It never belongs to a group; pass
`system: true` to `startsMessageGroup` for it.

## Accessibility

The rows render no landmark or `article` themselves. Inside `VirtualFeed`,
each item is an `article` in a `feed`, with arrow keys between messages. Pass
`itemLabel` with the author and time so each article has a name. Tab moves from
a message into its links, code blocks, "Show more", "Retry", and its actions;
the toolbar shows while focus is inside the row.

The avatar is hidden from screen readers because the name follows it.
A continuation row carries the author and time as visually hidden text. The
"Show more" button has `aria-expanded` and `aria-controls`. A copied code
block is announced in the shared live region; the application announces a
failed send. Code blocks are focusable so keyboard users can scroll them.

## Runtime

The rows render the same markup on the server and in the browser. They read
the inherited locale for their own words in English and German: "Sending",
"Not sent", "Retry", "Show more", "Copy", and the label of the toolbar.
Application text, such as the receipt, the badge, and action labels, comes
localized from the application.

Copy uses the browser clipboard. A web font that loads after a row mounted
changes its height like any text; `VirtualFeed` measures again and keeps the
reading position.

## Example

```tsx
const people = new Map([["u-nora", { name: "Nora Brandt" }]]);
const entry = (message?: ChatEntry) => message && { author: message.authorId, at: message.at, system: message.system };

<VirtualFeed
  items={messages()}
  getKey={(message) => message.id}
  estimateSize={(message) => (message.system ? 36 : 60)}
  label="Project Northern Lights"
  itemLabel={(message) => (message.system ? undefined : `${people.get(message.authorId)!.name}, ${clock(message.at)}`)}
>
  {(message, index) =>
    message.system ? (
      <MessageSystemRow icon="ti ti-user-plus" time={clock(message.at)}>
        {message.text}
      </MessageSystemRow>
    ) : (
      <MessageRow
        author={people.get(message.authorId)!}
        text={message.text}
        time={clock(message.at)}
        dateTime={message.at}
        own={message.authorId === me}
        groupStart={startsMessageGroup(entry(message)!, entry(messages()[index() - 1]))}
        status={message.authorId === me ? message.status : undefined}
        receipt={readBy(message)}
        onRetry={() => resend(message)}
        actions={[{ id: "reply", label: "Reply", icon: "ti ti-arrow-back-up", onSelect: () => reply(message) }]}
      />
    )
  }
</VirtualFeed>;
```
