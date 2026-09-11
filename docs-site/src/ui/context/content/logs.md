# Logs

`LogEntriesTable` renders application-owned log records with stable timestamp, level, source, message, and metadata columns.

## Use logs

Use the table for compact operational evidence. Fetching, filtering, pagination, retention, and permission checks remain application responsibilities.

## Import

```tsx
import { LogEntriesTable, type LogTableEntry } from "@k2b/ui";
```

## API reference

```ts
type LogTableEntry = {
  id: number | string; level: string; source: string; message: string;
  metadata: Record<string, unknown> | null; createdAt: string;
};
```

`LogEntriesTable` takes `entries: readonly LogTableEntry[]` and optional `emptyMessage: string`. Every entry field shown above is required; use `metadata: null` when absent. Known levels are `debug`, `info`, `warn`, `error`; other strings remain displayable.

## Accessibility

Levels combine text, icon, and color. Messages should remain understandable without opening metadata.

## Runtime

Rows render on the server. The component does not fetch or subscribe to logs.

## Example

```tsx
<LogEntriesTable
  entries={[{
    id: "42",
    level: "warn",
    source: "build",
    message: "Retry scheduled",
    metadata: { attempt: 2 },
    createdAt: "2026-07-28T09:43:00Z",
  }]}
/>
```
