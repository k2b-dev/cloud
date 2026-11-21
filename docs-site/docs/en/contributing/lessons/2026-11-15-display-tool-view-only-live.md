### A display tool's view lived only in the live stream

- **What happened:** Gustav's key figures and charts stood under his head while the turn ran, but after a reload they fell back to the tool's old drawing, and the box "In this chat" listed no result.
- **Root cause:** The executor gave the chat its view only through the live pipeline. The loop, and with it the stored message, kept `{ displayed: true }`, and no result source was indexed for the call.
- **Error class:** Presentation state written to one of two transcripts that must agree, the live stream and the stored history.
- **Guard:** The loop now keeps the full result, and the provider boundary reduces it for the model as it does for every view (`modelCapabilityMessage`). `executor.integration.test.ts` asserts the pushed result carries the view, what the model reads, and the indexed result source.
