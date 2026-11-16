### A stopped automatic review offered to answer an older personal message again

- **What happened:** When someone stopped Gustav during an automatic Code review, the stopped line offered "Neu antworten". It pointed at an earlier personal message that had failed, not at the review.
- **Root cause:** The chat timeline remembers the last unanswered personal prompt to retry. A review start is an activity line, not a person's message, so it did not clear that prompt, and the review's stopped answer inherited it.
- **Error class:** Turn state that a timeline carries forward (here the retry target) survives a turn that starts without a personal message.
- **Guard:** `stop-notice.render.test.tsx` renders an earlier failed question, a review start and a stopped review answer and asserts that no retry is offered; the review start resets the retry target in `presentation.tsx`.
