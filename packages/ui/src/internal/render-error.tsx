import { ErrorBoundary, type JSX, untrack } from "solid-js";
import { Button } from "../actions/Button";
import { useUiMessages } from "../intl/messages";
import Placeholder from "../surfaces/Placeholder";

/**
 * Guards a Solid root that @k2b/ui creates itself, such as a dialog or a floating window. These roots are mostly
 * opened from a click handler, outside any owner and any island boundary. Without a boundary of their own, content
 * that throws on an update throws into the code that wrote the signal and leaves other parts of the page stale.
 * The content is created untracked, as `render()` and components create it, so a signal it reads directly does not
 * rebuild it. `onClose` adds a Close button for a root whose content draws its own close control.
 */
export function RenderErrorBoundary(props: { content: () => JSX.Element; onClose?: () => void; onError?: () => void }): JSX.Element {
  return (
    <ErrorBoundary
      fallback={(error: unknown) => {
        globalThis.reportError(error);
        props.onError?.();
        return <RenderErrorNotice onClose={props.onClose} />;
      }}
    >
      {untrack(props.content)}
    </ErrorBoundary>
  );
}

function RenderErrorNotice(props: { onClose?: () => void }): JSX.Element {
  const messages = useUiMessages();
  return (
    <Placeholder
      state="error"
      title={messages().couldNotDisplayContent}
      action={
        props.onClose ? (
          <Button variant="secondary" onClick={() => props.onClose?.()}>
            {messages().close}
          </Button>
        ) : undefined
      }
    />
  );
}
