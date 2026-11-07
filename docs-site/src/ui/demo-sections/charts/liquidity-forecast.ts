/** Invented account balances; fixed dates keep the showcase and saved JSON reproducible. */
const day = (index: number) => new Date(Date.UTC(2026, 9, 1 + index)).toISOString().slice(0, 10);
const balances = Array.from({ length: 96 }, (_, index) => {
  const swing = Math.sin(index / 6) * 3800 + Math.sin(index / 2.3) * 1400;
  const trend = index < 60 ? 0 : -(index - 60) * 220;
  return Math.round((19800 + swing + trend + (index > 62 && index < 70 ? -6000 : 0)) / 10) * 10;
});
const today = 36;

/** Portable JSON shared by the line example and the Liquidity dashboard. */
export const liquidityForecastSpec = {
  kind: "line",
  title: "Balance",
  subtitle: "Business account · forecast with range from today",
  legend: true,
  series: [{ label: "Balance", data: balances.map((y, index) => ({ x: day(index), y })) }],
  step: "after",
  forecast: {
    from: day(today),
    band: balances.slice(today).map((value, index) => [value - 600 - index * 70, value + 600 + index * 70]),
  },
  threshold: { value: 10000, label: "Threshold" },
  marker: { at: day(today), label: "Today" },
  zero: true,
  yAxis: { format: { style: "currency", currency: "EUR", compact: true } },
};
