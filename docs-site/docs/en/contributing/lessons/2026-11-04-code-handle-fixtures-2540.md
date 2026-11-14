### Keep isolated fixtures aligned with shared account contracts

- **What happened:** CLI success responses, Assistant machine scenarios and a quota administration read failed after Code account handles were added.
- **Root cause:** The CLI fixture omitted the required handle field, and two isolated account schemas omitted the columns selected by the shared display resolver.
- **Error class:** Shared contract changes leave isolated test fixtures behind.
- **Guard:** The CLI response fixture satisfies the exported Code type. Assistant and quota integration fixtures include the handle and title columns, retaining their existing execution, cancellation and display assertions.
