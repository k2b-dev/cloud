# Island Error Boundaries

Every island and client component instance is mounted in its own error boundary by default. Do not add a root `ErrorBoundary` to each island just for protection.

- an error while mounting, deserializing props, or in a later reactive update replaces only that instance with `<div role="alert" data-ssr-error>` and a **Try again** button
- other instances and other islands updated by the same signal write keep working
- **Try again** (or `reset()`) remounts the component with fresh state from the same `data-props`
- each caught error dispatches a bubbling, cancelable `ssr:island-error` event on the wrapper element with `detail: { error, id, reset }`, then calls `reportError(error)` unless a listener called `preventDefault()`
- `preventDefault()` only suppresses the report; use it when the app sends errors to its own reporter
- style the default fallback through `[data-ssr-error]`
- for localized or branded fallbacks, set `createConfig({ errorFallback: "./src/IslandError.tsx" })`; its default export receives `IslandErrorProps` (`{ error, reset }`) from `@k2b/ssr`; if it throws, the default fallback is used
- boundaries inside a component still take precedence; errors thrown directly in event handlers or async callbacks outside a Solid computation remain normal uncaught errors

```tsx
import type { IslandErrorProps } from "@k2b/ssr";

export default function IslandError(props: IslandErrorProps) {
  return (
    <p role="alert">
      Could not load this section. <button type="button" onClick={props.reset}>Retry</button>
    </p>
  );
}
```
