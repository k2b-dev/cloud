### A late read request crossed a chat fixture reset

- **What happened:** The phone system-chat loading test failed immediately with an exception from a read request belonging to the preceding test. Its still-running body then overlapped later tests.
- **Root cause:** The browser fixture found a chat before awaiting the request body, then looked it up again while applying the read. A reset during that await removed the chat. Closing the browser context had not drained the server handler.
- **Error class:** An asynchronous request mutates shared test state after that state has been reset.
- **Guard:** The read route checks that the captured chat still belongs to the fixture after reading the body. A deterministic system-chat test holds the body, resets and seeds the next fixture, then releases the old request and checks for a 404 with no reads recorded into the next test's shared state.
