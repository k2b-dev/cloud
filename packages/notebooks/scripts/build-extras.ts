import { resolve } from "node:path";
import { buildMathAssets } from "./math-assets";

await buildMathAssets(resolve(process.env.DIST_DIR!, "public"));
