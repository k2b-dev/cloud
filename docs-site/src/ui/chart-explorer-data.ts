export const explorerSteps = Array.from({ length: 13 }, (_, index) => {
  const hour = String(index + 8).padStart(2, "0");
  return { key: hour, label: `${hour}:00` };
});
export const explorerSeries = [
  { key: "cached", label: "Cached", color: "var(--stdlib-chart-c1)", marker: "circle" as const },
  { key: "uncached", label: "Uncached", color: "var(--stdlib-chart-c2)", marker: "triangle" as const },
];
