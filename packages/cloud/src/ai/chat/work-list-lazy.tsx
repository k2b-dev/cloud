import { type ComponentProps, createSignal, type JSX, onMount, Show } from "solid-js";
import { importOnDemand } from "../../browser/reload";

type WorkList = typeof import("./work-list");
const [workList, setWorkList] = createSignal<WorkList>();
let loading: Promise<void> | null = null;

/**
 * Loads the opened work's code once. The work line calls it as soon as it is in the browser, so the steps are there
 * before anyone opens it; a failed load can be tried again.
 */
export const preloadAiWorkSteps = (): Promise<void> => {
  if (loading) return loading;
  const load = importOnDemand(() => import("./work-list")).then((module) => {
    if (module) setWorkList(() => module);
    else loading = null;
  });
  loading = load;
  return load;
};

/** The opened work; until its code is there, which takes a moment only on a first open, it shows nothing. */
export function AiWorkSteps(props: ComponentProps<WorkList["AiWorkSteps"]>): JSX.Element {
  onMount(preloadAiWorkSteps);
  return (
    <Show when={workList()}>
      {(module) => {
        const Steps = module().AiWorkSteps;
        return <Steps {...props} />;
      }}
    </Show>
  );
}
