### The thinking words never changed

- **What happened:** In the sixth Preview tour, Gustav's work line said "Denkt nach" after 4, 6.5 and 9 seconds of thinking; the words that should follow after 3 seconds never showed.
- **Root cause:** The line timed its words by the current step. A thinking block, a finished call, and the next thinking block are each a step, so the time and the round of words started again with every block, and real thinking changes blocks within a second.
- **Error class:** A timer keyed to a finer identity than the state the person sees.
- **Guard:** The thinking phase lasts as long as the line says "Thinking", across blocks (`turn-view.tsx`). A behavior test in `timeline.behavior.test.tsx` changes blocks every 0.7 s and expects a new word after 3 s and the announcement "Gustav is thinking".
