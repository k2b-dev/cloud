### One expired question, two notices

- **What happened:** In the seventh Preview tour a turn whose approval was not answered in time showed the question's line "Abgelaufen · Noch einmal fragen" and, right below, the notice "Die Antwort wurde unterbrochen: Die Freigabe oder Antwort kam nicht rechtzeitig · Weiterarbeiten": one cause, two messages, two ways out.
- **Root cause:** The turn's error notice and the question's outcome line are rendered independently; both react to the same expiry.
- **Error class:** Two owners reporting the same event without knowing of each other.
- **Guard:** The turn view leaves out the notice for `wait_expired` when an expired question in the turn already says it. `approval.behavior.test.tsx` checks one notice with one way out, and that the notice stays when no such question exists.
