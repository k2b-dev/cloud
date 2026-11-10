import { type Accessor, createEffect, createSignal, type JSX, onCleanup, untrack } from "solid-js";

export type SkeletonProps = { class?: string };

/** Decorative loading geometry. The consumer owns dimensions and one accessible loading status. */
export function Skeleton(props: SkeletonProps): JSX.Element {
  return <div class={`k2b-skeleton ${props.class ?? ""}`} aria-hidden="true" />;
}

export type DelayedLoadingOptions = {
  /** How long `pending` must last before the loading state shows. Defaults to 200 ms. */
  delay?: number;
  /** How long a shown loading state stays at least, also when the answer arrives sooner. Defaults to 300 ms. */
  minimum?: number;
};

/**
 * Whether a loading state, such as `Skeleton` rows, should show for `pending`: only once it lasted `delay`, then for at
 * least `minimum`. A fast answer never flashes placeholders, and a slow one never blinks them away. Until it is true,
 * keep the previous content in place. It starts false, so server and first client render agree.
 */
export function createDelayedLoading(pending: Accessor<boolean>, options: DelayedLoadingOptions = {}): Accessor<boolean> {
  const delay = options.delay ?? 200;
  const minimum = options.minimum ?? 300;
  const [shown, setShown] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shownAt = 0;
  createEffect(() => {
    const busy = pending();
    untrack(() => {
      clearTimeout(timer);
      timer = undefined;
      if (busy) {
        if (!shown())
          timer = setTimeout(() => {
            shownAt = performance.now();
            setShown(true);
          }, delay);
        return;
      }
      if (!shown()) return;
      const rest = minimum - (performance.now() - shownAt);
      if (rest <= 0) setShown(false);
      else timer = setTimeout(() => setShown(false), rest);
    });
  });
  onCleanup(() => clearTimeout(timer));
  return shown;
}
