import type { ComponentProps } from "solid-js";
import { CustomAppChartView } from "./Chart";

export default function CustomAppChartIsland(props: ComponentProps<typeof CustomAppChartView>) {
  return <CustomAppChartView {...props} />;
}
