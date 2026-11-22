import { expect, test } from "bun:test";
import { moneyExample } from "../examples/money";

const expected = {
  net: "1234.56", tax: "234.57", gross: "1469.13", reconciled: true,
  credit: [-34, -33, -33], creditSum: -100,
  maximum: "90.071.992.547.409,91\u00a0€", yen: "1234", dinar: "1234.567", negativeHalf: -2,
};

test("money invoice example in Bun", () => {
  expect(moneyExample()).toEqual(expected);
});

test("browser-target bundle runs in a worker without DOM or Node builtins", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../examples/money.ts", import.meta.url).pathname], target: "browser" });
  expect(build.success).toBe(true);
  const code = await build.outputs[0]!.text();
  const url = URL.createObjectURL(new Blob([code, '\npostMessage({ result: moneyExample(), dom: typeof document }); close();'], { type: "text/javascript" }));
  try {
    const response = await new Promise<unknown>((resolve, reject) => {
      const worker = new Worker(url, { type: "module" });
      worker.onmessage = event => resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
    });
    expect(response).toEqual({ result: expected, dom: "undefined" });
  } finally { URL.revokeObjectURL(url); }
});
