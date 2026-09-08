# UI components

`@k2b/ui` is a standalone component library for SolidJS. It combines accessible interaction patterns, scoped precompiled styles, configurable design tokens, and separate browser and server builds. Use it inside Cloud or in another Solid application. Cloud-specific integrations are documented separately.

```tsx
import "@k2b/ui/global.css";
import { Button, Placeholder } from "@k2b/ui";

export function EmptyProject() {
  return (
    <main class="k2b-ui">
      <Placeholder title="No project selected" />
      <Button>Select project</Button>
    </main>
  );
}
```

The `.k2b-ui` scope keeps component styles isolated from the host page. Fonts
and semantic color stacks use CSS variables, so each product can provide its
own typography and visual identity. Use the granular stylesheet, font, and icon
exports when the application does not want the complete preset.

## Portable components

The AI, Inputs, Actions, Layout, Surfaces, Feedback, Content, and Widgets sections cover the portable package. Each reference page renders the real component, shows its public import, and explains which state and behavior remain application-owned.

The package owns presentation and reusable interaction behavior. Applications continue to own domain data, navigation, persistence, authorization, uploads, AI protocols, and service calls.

## Cloud components

Four integrations remain product-specific because their behavior depends on authenticated Cloud APIs or platform concepts:

- **Cloud assistant chat** — Cloud Assistant messages, tools, sessions, and attachments;
- **Permissions and API keys** — identity, principal search, resource permissions, and scoped credentials;
- **Cloud dashboard widgets** — Cloud endpoint adapters feeding portable widget presentation;
- **Cloud resource picker** — permission-filtered selection of stable Cloud resource references through Universal Search.

They live in their own **Cloud components** section, keeping the portable package boundary explicit.
