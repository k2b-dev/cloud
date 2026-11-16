### A model wrote bare citation numbers and its own sources paragraph

- **What happened:** In the Preview tour, Kimi K3 cited with bare "[1]" and "[2]" and ended its answer with a paragraph "Quellen: [1] … [2] …". The answer showed no citation chips, the sources paragraph repeated what the row under the answer lists, and the row showed one source while the text named two.
- **Root cause:** The chat only recognized citations written as a numbered link, the one form the system prompt asked for. A model that does not follow the format left the numbers as text and the sources twice.
- **Error class:** A chat feature that relies on the model following one output format, without a reading of the forms models actually write.
- **Guard:** `answer-sources.test.ts` reads the Preview answer as a fixture: bare numbers become chips with the destinations of the model's own sources paragraph or list, which leaves the answer, and the row lists exactly the cited numbers. The system prompt now also says never to write a bare number or a sources list.
