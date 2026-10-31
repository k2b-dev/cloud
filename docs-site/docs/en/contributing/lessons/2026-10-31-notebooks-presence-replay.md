### The note's detail panel missed who was here

- **What happened:** The Notebooks detail panel could show nobody in a note that others had open, and after switching notes it could keep the people of the previous note.
- **Root cause:** The server sends the presence snapshot once per connection. The editor forwarded it as a window event and kept no copy, so a panel that mounted or asked for the editor's state after the snapshot never received it; the panel also kept its list across a note switch.
- **Error class:** A one-time snapshot passed on as an event without replay to listeners that subscribe later.
- **Guard:** `NoteEditor.behavior.test.tsx` delivers the snapshot first, then asks for the state as a mounting panel does, and expects the people who are here.
