### Threaded-chat Back ignored the recorded predecessor

- **What happened:** Header Back from a threaded chat opened from the list showed the thread directory while browser Back returned to the list; with Info open, returning to the directory also lost the Forward path.
- **Root cause:** The header chose its target and handler from the chat's thread count instead of its recorded list predecessor, and Info discarded the thread-directory predecessor marker.
- **Error class:** Navigation ancestry inferred from domain structure instead of the current history entry.
- **Guard:** ChatWorkspace.behavior.test.tsx covers phone and wide list → threaded chat → header Back → Forward with and without Info, in the Cloud app and web, plus direct-link replacement and predecessor synchronization after filter navigation; ChatWorkspace.browser.test.ts checks visible Cloud app controls and Forward in both widths.
