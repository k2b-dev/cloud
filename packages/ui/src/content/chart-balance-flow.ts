import { mountBalanceFlowController } from "./chart-balance-flow-controller";
import { inspectChart } from "./chart-inspection-mount";

export { selectBalanceFlowDatum } from "./chart-balance-flow-controller";
/** Standard host enhancement; app frames supply their existing inspector to the lazy controller instead. */
export const mountBalanceFlow = (root: HTMLElement, options: Parameters<typeof mountBalanceFlowController>[1] = {}): (() => void) =>
  mountBalanceFlowController(root, options, inspectChart);
