### Text scrolled on under the compose window's bar

- **What happened:** In the Mail compose window, normal and maximized, the bar with Send stood a little above the
  window's bottom edge. Text kept scrolling through the gap below it, and the signature showed there cut off.
- **Root cause:** The bar is `position: sticky; bottom: 0` inside a scroller with `padding-bottom: 0.5rem`. Sticky
  positioning keeps the scroller's padding free, so the bar stuck 8 px above the edge. The same inset at the top let
  text show above the sticky head of a maximized window.
- **Error class:** A sticky head or bar inside a scroller that has its own padding on that side.
- **Guard:** The compose window's scrollers have no block padding; head and bar carry their room themselves. The Mail
  shell browser test "Maximize turns a new message window large …" measures that the bar's bottom equals the
  scroller's bottom in the normal and the large window.
