### SDK calls use records that workerd RPC can serialize

- **What happened:** Generated SDK calls failed before reaching the fake bridge in the production sandbox.
- **Root cause:** The SDK created its normalized refs record with a null prototype, which workerd RPC cannot serialize.
- **Error class:** In-memory values exceed the transport serialization contract.
- **Guard:** The SDK runtime test checks plain refs records and cloneable invocations for empty and populated refs. The Code test-kit engine acceptance executes the actual C16 bundle across workerd RPC in the Runner image.
