export const balanceFixture = {
  currency: "EUR",
  locale: "en-GB",
  periods: [
    {
      label: "October 2026",
      opening: 1200,
      inflows: [{ label: "Marketplace orders", value: 8400 }],
      outflows: [
        { label: "Cases", value: 120 },
        { label: "Refunds", value: 320 },
        { label: "Marketplace fees", value: 760 },
        { label: "Shipping labels", value: 400 },
        { label: "Payouts", value: 6000 },
      ],
      closing: 2000,
    },
    {
      label: "November 2026",
      opening: 2000,
      inflows: [{ label: "Marketplace orders", value: 7200 }],
      outflows: [
        { label: "Fees and shipping", value: 1200 },
        { label: "Payouts", value: 6500 },
      ],
      closing: 1500,
    },
    {
      label: "December 2026",
      opening: 1500,
      inflows: [{ label: "Marketplace orders", value: 10300 }],
      outflows: [
        { label: "Fees and shipping", value: 1800 },
        { label: "Payouts", value: 7000 },
      ],
      closing: 3000,
    },
  ],
};
