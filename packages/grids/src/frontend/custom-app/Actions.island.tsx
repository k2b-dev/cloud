import type { ComponentProps } from "solid-js";
import Actions from "./Actions";

export type { CustomAppRenderedAction } from "./Actions";

export default function ActionsIsland(props: ComponentProps<typeof Actions>) {
  return <Actions {...props} />;
}
