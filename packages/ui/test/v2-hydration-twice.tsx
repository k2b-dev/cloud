import { type JSX, Show } from "solid-js";
import { generateHydrationScript, hydrate, isServer, renderToString } from "solid-js/web";

// The red case of the hydration test: a component that reads a prop holding JSX twice, as the primitives did before
// the review of #4058. The server sends the second copy, the browser looks for the first; hydration must fail.

const Twice = (props: { part: JSX.Element }) => <Show when={props.part}>{props.part}</Show>;
const Page = () => (
  <div>
    <Twice part={<span>Teil</span>} />
  </div>
);

declare global {
  interface Window {
    __k2TwiceDone?: boolean;
  }
}

/** The page as the server sends it. */
export const render = () => ({ html: renderToString(() => <Page />), script: generateHydrationScript() });

if (!isServer && typeof document !== "undefined" && document.getElementById("twice")) {
  try {
    hydrate(() => <Page />, document.getElementById("twice")!);
  } finally {
    window.__k2TwiceDone = true;
  }
}
