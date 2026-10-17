import GraphCanvas, { type GraphDisplayProps } from "./GraphCanvas";

import type { NetPoint } from "./layout-net";

export type { GraphZoomControls } from "./GraphCanvas";

/** Whole-notebook force layout; only this display permits node dragging. */
export default function NetworkDisplay(props: GraphDisplayProps & { layout: () => Promise<Map<string, NetPoint> | null> }) {
  return <GraphCanvas {...props} />;
}
