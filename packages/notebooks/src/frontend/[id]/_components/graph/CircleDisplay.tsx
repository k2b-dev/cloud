import GraphCanvas, { type GraphDisplayProps } from "./GraphCanvas";

export default function CircleDisplay(props: GraphDisplayProps) {
  return <GraphCanvas {...props} circle />;
}
