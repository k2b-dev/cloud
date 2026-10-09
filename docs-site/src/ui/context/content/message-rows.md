# Message rows

`MessageRow` shows one message in a conversation with many people. Others'
messages sit on the left with a round avatar, the reader's own on the right in
the accent tint. Messages by the same author within five minutes form a group:
only the first shows the avatar, name, and time. `MessageSystemRow` is a quiet,
centered line for something that happened, such as a person joining.

A row can also show the message it answers, a forward or edit marker, images,
videos, and files, a link preview and a card, reactions, a thread bar, and a
message that is still being written.

Every part of a row has its final height when it mounts, so the rows compose
with [`VirtualFeed`](/en/ui/content/virtual-feed) and the feed keeps its
positions. The application owns the messages, their order, sending, read
state, reactions, threads, uploads, and every action. The rows own layout, the
safe text rendering, the reserved areas, the send state, and the action
toolbar.

## Import

```tsx
import {
  MessageRow,
  MessageSystemRow,
  startsMessageGroup,
  type MessageRowAction,
  type MessageRowAttachment,
  type MessageRowAuthor,
  type MessageRowFile,
  type MessageRowMedia,
  type MessageRowProgress,
  type MessageRowProps,
  type MessageRowQuote,
  type MessageRowReaction,
  type MessageRowStatus,
  type MessageRowThread,
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
while `status` or `receipt` is set. When it shares its line with reactions,
the icon, "Sending" or "Not sent", and "Retry" keep their full width; the
receipt and the chips share the rest, and the receipt keeps at least its
longest word. Set `status` on every own message from the start, so the line
is reserved and a send that completes, fails, or is read never moves the rows
below it.

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

### Quotes, forwards, and edits

`quote` shows the message this one answers above the bubble: a reply arrow,
the quoted author's name, and the quoted text, at most two lines. Pass the
quoted text as plain text. With `onSelect`, the quote is a button, for example
to jump to the quoted message with `VirtualFeed`'s `scrollToKey`.

`forwarded` adds a "Forwarded" line above the bubble. `edited` ends the last
paragraph of the text with a quiet "edited", so it takes no line of its own
unless the text ends in a code block, list, or table. A collapsed message
shows it next to "Show more" instead, where the reader can see it, and a
message without text, such as pictures alone, shows it as a line in place of
the bubble.

### Deleted messages

`deleted` replaces the bubble with "This message was deleted", outlined
instead of filled and as tall as a one-line message. A deleted message shows
no text, quote, markers, attachments, previews, or reactions, even when they
are passed. The thread bar, the send state line, and the actions stay as the
application passes them.

### Attachments

`attachments` lists images, videos, and files. Images and videos come first,
in a grid with areas reserved before anything loads, then files as chips.

- **Images and videos** (`kind: "image"` or `"video"`) need `src` (for a
  video, its poster frame), `alt`, and the stored pixel `width` and `height`.
  A single picture keeps its aspect ratio, at most 20 rem tall and never
  wider than its stored width or the row. A ratio beyond 1:2 or 3:1 is
  cropped to that bound. Two to four pictures share a square grid, three with
  a wide first cell. More than four show the first four, and the last one says
  how many more there are ("+2"). Pressing it opens the fourth picture, so for
  more than four, pass an `onOpen` that opens a gallery of all of them, such
  as `Lightbox`; with `href` alone, the hidden pictures cannot be opened.
- **Files** (`kind: "file"`) show an icon chosen from `name` and `mediaType`,
  or your `icon`, the name, and an optional `detail` such as "PDF · 412 KB".

There is no placeholder picture: the reserved area shows a quiet fill until
the image arrives, and the image only paints into it. Store the size of every
image and video poster when it is uploaded; a picture without a size reserves
a 4:3 area.

Each attachment opens through `onOpen`, for example in a lightbox, or through
`href` in a new tab. Without either, it is shown but is not a control. URLs
must be relative or use `https` or `http`. A picture's `src` may also be a
`blob:` URL, for a file that is still uploading, or a `data:image/` URL.
Other images do not load and other links do not open. An `href` is never a
`blob:` URL, because the opened file would run in the application's origin;
leave a file that is still uploading without `href` until it is stored. A
picture is named by its `alt`, plus "Video"
and the duration for a video and the number of hidden pictures for the last
cell of a full grid. A message with attachments and an empty `text` shows no
bubble.

### Link previews and cards

`linkPreview` and `card` are slots below the attachments: a preview of a link
in the text, and a card for an element the message refers to, such as a task
or a document. The application builds both, ideally with `@k2b/ui` surfaces,
and gives them their final height when they mount. For `card`, use
[`ResourceCard`](/en/ui/surfaces/cards): it has the same size while it loads,
when it shows the element, and when the reader has no access or the element is
gone. A preview that is fetched
later should be passed only once its data is there, or reserve its height from
the start.

### Reactions

`reactions` shows a bar of chips: the emoji and the count, the reader's own
reactions highlighted. With `onToggleReaction`, every chip is a toggle button
that reports its `key`; without it, the chips are not controls.
`onAddReaction` adds an "Add reaction" button at the end of the bar and
receives that button, so a picker such as
[`EmojiPicker.Popover`](/en/ui/input/emoji-picker) can open next to it. A chip's `label`, for
example "Nora, Tobias", is read by screen readers and shown as a tooltip.

Each chip keeps its element for its `key`. A toggled chip keeps focus when the
application passes a new list of new objects, as long as the message itself
is updated in place (see [Update messages in place](#update-messages-in-place)).

The bar has one fixed height. Chips never wrap; when there are more than fit,
the chips scroll sideways, a fade at the edge shows that more follow, and
"Add reaction" stays in place. Toggle chips are reached with Tab; read-only
chips are not, so their list is a tab stop that the arrow keys scroll. On an
own message, the bar shares its line with the send state.

The bar shows whenever `reactions` is set, also to an empty list, and keeps
its height while chips come and go. While it is empty, "Add reaction" shows
only while the message is hovered or focused, like the actions. Only a
message whose `reactions` changes from unset to a list grows, by one line.

Reserve the bar on exactly these messages:

- Every own message: pass `reactions`, also as an empty list. The bar shares
  the line of the send state, so it costs a few pixels.
- Every other message that has or had a reaction: keep passing an empty list
  after the last one is removed, so removing a reaction never moves anything.

Leave `reactions` out on other people's messages that never had a reaction. A
reserved, empty line under every message would pull each group apart. The
first reaction on another person's message therefore adds one line, once;
later reactions and removals keep the height. Inside `VirtualFeed`, the reader
keeps their place: at the end, the end stays in view; scrolled up, the item at
the top stays, and only the rows below the reacted message move.

### Threads

`thread` adds a bar of fixed height below the message that opens its replies
through `onOpen`. It shows up to three of the `participants`, the reply count,
and "Last reply" with the application's formatted `lastReply` time; a long
time ends in an ellipsis. Pass `thread` from the first reply on. The first
reply adds the bar like a new line; every later reply only changes its text.

### Messages in progress

`progress` marks a message that is still being written, by a person or an
automated author alike: its line shows a spinner, the application's `status`
text, such as "Writing" or "Searching the files", and, with `onStop`, a "Stop"
button. While the text is empty, the bubble shows three quiet dots instead.
The bubble is `aria-busy` while `progress` is set, which tells assistive
technology that its content is still changing. The row announces nothing:
like a failed send, announce what the reader should hear, such as the start
or the end of an answer, where the application learns of it, for example with
`announce`.

A message in progress grows as its text arrives. Stream the text into the
message in place, so a reader who moved focus to "Stop" keeps it. `VirtualFeed`
keeps the reader at the end while they are there. When `progress` ends, the
line goes away unless `status` or `receipt` is set, so set `status` on own
messages to keep it.

### Update messages in place

`VirtualFeed` mounts a new row for a replaced item object, and focus moves
from the control the reader was using, such as "Stop", a reaction chip, or
"Retry", to the message. Change the parts of a message that update while
someone may be working in it, such as `text`, `progress`, `status`,
`receipt`, `reactions`, and `thread`, in place: read them from a signal or a
Solid store inside the row's JSX. With a store, pass a new array only when
messages come or go:

```tsx
const [messages, setMessages] = createStore<ChatMessage[]>([]);

const stream = (id: string, token: string) =>
  setMessages((message) => message.id === id, "text", (text) => text + token);

<VirtualFeed items={messages.slice()} getKey={(message) => message.id} estimateSize={() => 60} label="Project chat">
  {(message) => <MessageRow author={people.get(message.authorId)!} text={message.text} time={clock(message.at)} />}
</VirtualFeed>;
```

### Actions

`actions` are icon buttons with a label each. They appear as a small toolbar
over the top corner of the row while a mouse or pen rests on it or focus is
inside it, so they never move anything. On a phone or tablet, the first tap
on a message focuses its row and shows them without pressing the action under
the finger. Keep the list short, about two to four actions.

### Touch screens

On a device with a coarse pointer, the quote, the thread bar, the reaction
chips, and the buttons in a row accept taps in the shared 44 px area of
[touch targets](/en/ui/actions/buttons#touch-targets), while they look the
same. To keep those areas from reaching over each other, a touch screen keeps
0.625rem between a thread bar or footer and the pictures, files, preview, or
thread bar above it, and adds 0.625rem above a quote that opens a
continuation and below a row that ends in a thread bar or footer. The device
decides this room, not the message's state, so nothing moves while the
reader is there.

### System rows

`MessageSystemRow` takes the text as children, an optional `icon`, and an
optional `time` with `dateTime`. It never belongs to a group; pass
`system: true` to `startsMessageGroup` for it.

## Accessibility

The rows render no landmark or `article` themselves. Inside `VirtualFeed`,
each item is an `article` in a `feed`, with arrow keys between messages. Pass
`itemLabel` with the author and time so each article has a name. Tab moves from
a message into its quote, links, code blocks, "Show more", attachments, the
thread bar, reaction chips, "Add reaction", "Retry" or "Stop", and its actions;
the toolbar shows while focus is inside the row.

The quote is read as "In reply to" the author. Reaction chips are toggle
buttons with `aria-pressed`, named by emoji, count, and `label` ("👍 3
reactions: Nora, Tobias"), in a group named "Reactions". Read-only chips say
which are the reader's own instead ("☕ your reaction: Robin", "👍 3
reactions, including yours"), and in forced colors the reader's own chips
have a thicker outline. The thread bar is one button named by its count and
last reply; its avatars are hidden. Pictures are named by their `alt` text,
and the attachments form a group named "Attachments".

The avatar is hidden from screen readers because the name follows it.
A continuation row carries the author and time as visually hidden text. The
"Show more" button has `aria-expanded` and `aria-controls`. A copied code
block is announced in the shared live region; the application announces a
failed send. Code blocks are focusable so keyboard users can scroll them.

## Runtime

The rows render the same markup on the server and in the browser. They read
the inherited locale for their own words in English and German: "Sending",
"Not sent", "Retry", "Show more", "Copy", the label of the toolbar, "In reply
to", "Forwarded", "edited", "This message was deleted", "Video", the count of
hidden pictures, "Reactions", "Add reaction", the reaction counts and "your
reaction", the reply count, "Last reply", and "Stop". Application text, such
as the receipt, the badge, the progress status, reaction labels, alt text,
and action labels, comes localized from the application.

Copy uses the browser clipboard. Images load lazily into their reserved
areas. A web font that loads after a row mounted
changes its height like any text; `VirtualFeed` measures again and keeps the
reading position.

## Example

`messages` is a Solid store, so a message changes in place (see
[Update messages in place](#update-messages-in-place)).

```tsx
const people = new Map([["u-nora", { name: "Nora Brandt" }]]);
const entry = (message?: ChatEntry) => message && { author: message.authorId, at: message.at, system: message.system };

<VirtualFeed
  items={messages.slice()}
  getKey={(message) => message.id}
  estimateSize={(message) => (message.system ? 36 : 60)}
  label="Project Northern Lights"
  controller={(controller) => (feed = controller)}
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
        groupStart={startsMessageGroup(entry(message)!, entry(messages[index() - 1]))}
        status={message.authorId === me ? message.status : undefined}
        receipt={readBy(message)}
        onRetry={() => resend(message)}
        quote={message.replyTo && { ...quoteOf(message.replyTo), onSelect: () => feed.scrollToKey(message.replyTo!, { highlight: true }) }}
        edited={message.editedAt !== undefined}
        deleted={message.deletedAt !== undefined}
        attachments={message.files.map((file) =>
          file.width ? { kind: "image", src: file.previewUrl, alt: file.alt, width: file.width, height: file.height, onOpen: () => openLightbox(message, file) }
            : { kind: "file", name: file.name, detail: describe(file), mediaType: file.type, href: file.url },
        )}
        reactions={
          message.authorId === me || message.hadReactions
            ? message.reactions.map((reaction) => ({ ...reaction, own: reaction.by.includes(me) }))
            : undefined
        }
        onToggleReaction={(emoji) => toggleReaction(message, emoji)}
        onAddReaction={(anchor) => setReactionTarget({ anchor, message })}
        thread={message.replies > 0 ? { count: message.replies, lastReply: clock(message.lastReplyAt), onOpen: () => openThread(message) } : undefined}
        progress={message.streaming ? { status: "Writing", onStop: () => stopAnswer(message) } : undefined}
        actions={[{ id: "reply", label: "Reply", icon: "ti ti-arrow-back-up", onSelect: () => reply(message) }]}
      />
    )
  }
</VirtualFeed>;
```
