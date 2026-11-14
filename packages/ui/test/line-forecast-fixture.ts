export const lineForecastFixture = {
  legend: true,
  legendPlacement: "top-start" as const,
  zero: true,
  smooth: false,
  series: [
    {
      label: "Cash",
      data: [
        { x: 1, y: 32_000 },
        { x: 2, y: 28_000 },
        { x: 3, y: 36_000 },
        { x: 4, y: 22_000 },
        { x: 5, y: 15_000 },
        { x: 6, y: 8_000 },
        { x: 7, y: -3_000 },
        { x: 8, y: 12_000 },
        { x: 9, y: 24_000 },
      ],
    },
    {
      label: "Committed",
      data: [
        { x: 1, y: 24_000 },
        { x: 2, y: 22_000 },
        { x: 3, y: 26_000 },
        { x: 4, y: 18_000 },
        { x: 5, y: 10_000 },
        { x: 6, y: 4_000 },
        { x: 7, y: -6_000 },
        { x: 8, y: 7_000 },
        { x: 9, y: 16_000 },
      ],
    },
  ],
  forecast: {
    from: 5,
    band: [
      [11_000, 19_000],
      [2_000, 14_000],
      [-10_000, 4_000],
      [3_000, 21_000],
      [12_000, 36_000],
    ] as [number, number][],
  },
  threshold: { value: 10_000, label: "Reserve" },
  marker: { at: 5, label: "Heute" },
};
