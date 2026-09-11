import ChartFixture from "./ChartFixture.island";
import { ssr } from "./config";

export default ssr((context) => {
  const window = context.req.query("window") === "1h" ? "1h" : "24h";
  context.get("page").title = "@k2b/ui SSR chart fixture";
  return () => <ChartFixture window={window} />;
});
