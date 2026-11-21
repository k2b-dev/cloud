### The reply box cut off its signature instead of scrolling

- **What happened:** Above the conversation, the reply box held a fixed 21 rem until the first click. Text and signature
  shrank inside it, the signature first, and faded out. A click then lifted the height without any upper limit, so focus
  alone moved the messages below. The compose window and "Write large" scrolled the whole draft with sticky head and bar
  instead.
- **Root cause:** The box shrank content in a container of fixed height (`flex-shrink: 1000`, `overflow: hidden`,
  `data-reply-box-clipped` in `app.css` and `MailReplyBox.tsx`), and each form had its own scroll model.
- **Error class:** Content is squeezed or clipped in a fixed-height container instead of scrolling.
- **Guard:** Every form now has a head, one scrolling surface (`[data-mail-compose-body]`), and a bar.
  `createComposeFit` (`mail-compose-fit.ts`) measures the reply box again only after the person's own input. The Mail
  shell browser suite checks, for the reply box above and below the conversation:
  - one scroller;
  - text, signature, and quote card keep their whole height;
  - Send ends 10 px above the bottom edge;
  - no hole below the content;
  - the first line starts 12 px under the head;
  - text, signature, quote line, and Send share one edge;
  - focus keeps the height.
