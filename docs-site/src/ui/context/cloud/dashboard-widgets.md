# Cloud dashboard widgets

Cloud applications can expose bounded `WidgetResponse` JSON endpoints to the shared dashboard. The endpoint, session, permissions, route, and response contract are Cloud-specific; the rendered widget components also exist portably in `@k2b/ui`.

## Use Cloud dashboard widgets

Register an endpoint when users need a compact cross-application summary or a direct route into a common task. Do not reproduce an entire application screen.

Use the portable widget components directly when the host already owns its data and layout and does not need Cloud endpoint discovery.

## Import

```ts
import type { WidgetResponse } from "@k2b/cloud/contracts";
```

## Endpoint contract

Cloud invokes the widget on behalf of the signed-in user using a target-bound credential, not the user's session cookie. The handler applies every required permission, keeps its query bounded, and returns:

- `200` with `WidgetResponse`;
- `204` when there is no relevant content;
- `403` when the user lacks access;
- another error only for a real failure.

One slow or failed endpoint must not block the dashboard.

## Accessibility

Every stat needs a label and context. Widget and row links need destination-specific text. Status blocks must state their result in text instead of relying on tone or icons.

## Runtime

Cloud discovers registered widget endpoints during server rendering and applies a bounded timeout. Endpoint responses are JSON; applications never return Solid elements through this contract.

## Example

```ts
const body: WidgetResponse = {
  title: "Recent notes",
  icon: "ti ti-notebook",
  href: "/app/notebooks",
  blocks: [
    {
      kind: "list",
      grow: true,
      items: notes.map((note) => ({
        label: note.title,
        sub: note.notebookName,
        href: `/app/notebooks/${note.notebookId}/notes/${note.id}`,
      })),
    },
  ],
};

return c.json(body);
```
