### A survey showed three states at once

- **What happened:** In the sixth Preview tour a survey whose answer had not come in time showed locked choices, "Wartet darauf, dass der Assistent weitermacht." and the notice "Die Antwort wurde unterbrochen" together.
- **Root cause:** `SurveyToolView` fell back to a locked survey with the waiting sentence for every state that was not answerable, including a turn that had already ended.
- **Error class:** A fallback that stands for "not yet" also used for "never again".
- **Guard:** An ended turn shows an unanswered survey with its questions and "Nicht beantwortet." only; the waiting sentence names Gustav. A behavior test in `timeline.behavior.test.tsx` breaks a turn off while its survey waits.
