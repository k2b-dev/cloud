### An empty answer after a failed step looked finished

- **What happened:** A tool call failed, and the model's next response stopped without text and without a tool call ([#1150](https://github.com/k2b-dev/cloud/issues/1150)). The turn finished as completed, so the chat showed the last progress sentence as the final answer and gave no hint that the work had stopped.
- **Root cause:** The executor treated every `stop` from the model loop as a completed turn and did not check whether the final response answered at all. Failure tracking also survived a later text answer and missed malformed calls saved before their error results.
- **Error class:** Silent failure.
- **Guard:** Such a turn now fails with `tool_failed`. Executor integration tests cover the empty answer, also after worker recovery with a malformed call missing its result, and the cases that stay completed (a text answer after the failure, a later successful round, a rejected approval). An executor unit test covers a text answer followed by late steering and an empty response. Timeline behavior and browser tests keep the failure notice at the turn's end, live and after reload.
