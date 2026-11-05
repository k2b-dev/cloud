### Temporary SMTP rejections gave up after about seven minutes

- **What happened:** A 4xx answer from the SMTP server, such as a sending limit or a quota, used the general budget of five attempts with short pauses. After about seven minutes the send failed and returned to the drafts, although such limits often last longer.
- **Root cause:** One attempt counter served unrelated purposes: retries of a temporary rejection, retries before dispatch, checks of an unclear send, and Sent copy retries.
- **Error class:** A shared retry budget sized for one failure kind and spent by another.
- **Guard:** `sent-projection.integration.test.ts` ("an SMTP rejection never sends twice and always ends visible: 4xx retries for about an hour…") requires seven rejections in a row to keep the send waiting, with a pause that grows to 15 minutes. A rejection after the hour must return the message to the drafts, each attempt must submit once, and a send that gets through must keep the full Sent copy budget. The outbox attempt is given back while the command attempt keeps counting, because it fences the worker against its effect marker. The test fails without the fix.
