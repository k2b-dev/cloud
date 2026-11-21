### Keep private entry outside conversation data

- **What happened:** Secret entry needed to reach automation editors from a conversation while preserving the existing write-only boundary.
- **Root cause:** The chat-only input and dialog could not express an automation target or share the Code page's permission-aware write contract.
- **Error class:** Private-input transport confused with model-visible conversation data.
- **Guard:** Contract, controller, transport and runtime tests reject invalid targets, check editor access before entry, and verify metadata-only results, timeline receipts, waiting entries and logs. Capability integration tests verify that Cloud administrators without editor rights cannot list or write the values.
