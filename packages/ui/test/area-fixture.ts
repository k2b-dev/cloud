export const areaFixture = {
  layout: "stacked" as const,
  normalize: true,
  x: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
  series: [
    { label: "Subscriptions", data: [120, 140, 130, 150, 170, 180] },
    { label: "Projects", data: [180, 160, 170, 140, 130, 120] },
    { label: "Training", data: [40, 50, 60, 50, 60, 80] },
  ],
};
