import { z } from "zod";

const ChartPartAsset = z.object({ code: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) });
export const ChartPartsAsset = z.object({ shared: ChartPartAsset, kinds: z.record(z.string(), ChartPartAsset) });
const base = { prelude: z.string(), preludeHash: z.string(), baseCss: z.string() };
export const AppFrameAsset = z.object({ ...base, chartParts: ChartPartsAsset });
export const PreparedChartAssets = z.object({ chartParts: ChartPartsAsset });
export const FrameAsset = z.object({
  ...base,
  chartHashes: z.object({ shared: z.string(), kinds: z.record(z.string(), z.string()) }),
});
