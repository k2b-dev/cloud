import type { IslandErrorProps } from "@k2b/ssr";
import { lazy } from "solid-js";

/** The view of a failed island, with its words and v2 `Failed`: loaded only when an island fails. */
const View = lazy(() => import("./IslandErrorView"));

/**
 * Takes the place of an island or client component whose rendering failed. `defineApp` hands it to @k2b/ssr as
 * `errorFallback`, so every island of every app carries it: it stays a stub, and its view (`IslandErrorView`: the v2
 * `Failed` state with its words and the shared catalog of `@k2b/ui`) loads only when an island fails.
 */
export default function IslandError(props: IslandErrorProps) {
  return <View error={props.error} reset={props.reset} />;
}
