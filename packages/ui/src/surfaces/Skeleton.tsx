import type { JSX } from "solid-js";

export type SkeletonProps = { class?: string };

/** Decorative loading geometry. The consumer owns dimensions and one accessible loading status. */
export function Skeleton(props: SkeletonProps): JSX.Element {
  return <div class={`k2b-skeleton ${props.class ?? ""}`} aria-hidden="true" />;
}
