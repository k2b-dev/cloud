### A checker warning appeared once per page

- **What happened:** A version with two pages that do not check the signed-in person showed the warning "This page does
  not check the signed-in person." twice, both in the chat after Gustav submitted it and on the administrator's approval
  page.
- **Root cause:** The checker reports a finding once per place, which the model and the CLI need. `describeCodeNotices`
  (`packages/core/src/code/read-model/notices.ts`) turned every report into its own sentence, although the sentences carry
  no place.
- **Error class:** Machine findings repeated one-to-one in words a person reads, where the distinguishing detail is gone.
- **Guard:** `describeCodeNotices`, the one translation from checker codes to sentences for chat, Code page and approval,
  shows each sentence once in its first position. `chat-words.test.ts` and `observations.test.ts` cover repeated warnings,
  repeated blocking findings and unknown codes that share the fallback sentence.
