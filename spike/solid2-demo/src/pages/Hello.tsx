import { ssr } from "../config";
import Counter from "../islands/Counter.island";

export default ssr(async (c) => {
  c.get("page").title = "Hello";
  return () => (
    <main>
      <h1>Solid 2 SSR</h1>
      <Counter initial={5} />
    </main>
  );
});
