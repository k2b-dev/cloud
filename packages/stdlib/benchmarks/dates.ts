import { dates } from "../src/index";

const ITERATIONS = 100;
const ROUNDS = 10;
const TARGET_MS = 50;
const START = "2026-01-01T08:00:00.000Z";
const EXPECTED = "2026-04-11T07:00:00.000Z";

const run = (): number => {
  let instant = START;
  const startedAt = performance.now();

  for (let index = 0; index < ITERATIONS; index++) {
    instant = dates.addZonedInstant(instant, {
      timeZone: "Europe/Berlin",
      days: 1,
    });
  }

  const elapsed = performance.now() - startedAt;
  if (instant !== EXPECTED) {
    throw new Error(`Unexpected benchmark result: ${instant}`);
  }
  return elapsed;
};

const cold = run();
const samples = Array.from({ length: ROUNDS }, run).sort((a, b) => a - b);
const best = samples[0]!;
const median = samples[Math.floor(samples.length / 2)]!;

console.log(`dates.addZonedInstant() x ${ITERATIONS}`);
console.log(`cold:   ${cold.toFixed(3)} ms`);
console.log(`best:   ${best.toFixed(3)} ms`);
console.log(`median: ${median.toFixed(3)} ms`);
console.log(`target: < ${TARGET_MS} ms`);

if (median >= TARGET_MS) {
  throw new Error(`Benchmark target missed: median ${median.toFixed(3)} ms`);
}
