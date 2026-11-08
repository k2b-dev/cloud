### Confirmed navigation must preserve the history operation

- **What happened:** The photo editor resumed a confirmed Back or link with document navigation. Back could append the previous URL and discard forward history.
- **Root cause:** The retry used a full document load instead of the enhanced navigation contract after the history-backed prompt closed.
- **Error class:** History traversal replaced by a new navigation.
- **Guard:** The public ImageEditor browser guard installs real page swapping, vetoes and cancels a link and Back, then confirms each. It checks the destination, retained document sentinel, and bounded history length. Back uses its negative delta; links and Forward use swapPage after event.restored.
