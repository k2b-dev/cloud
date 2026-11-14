/** Fictional data; ChartShowcaseExample[] shape for the shared registry. */
export const treemapExamples = [
  {
    id: "treemap-inventory",
    kind: "treemap",
    question: "share" as const,
    title: "Inventory by category",
    summary: "Area represents inventory value; color identifies the department.",
    spec: {
      kind: "treemap",
      title: "Inventory by category",
      groups: ["Furniture", "Lights", "Art"],
      data: [
        {
          label: "Cabinets",
          group: "Furniture",
          value: 24000,
        },
        {
          label: "Tables",
          group: "Furniture",
          value: 16000,
        },
        {
          label: "Chairs",
          group: "Furniture",
          value: 11000,
        },
        {
          label: "Lamps",
          group: "Lights",
          value: 13000,
        },
        {
          label: "Paintings",
          group: "Art",
          value: 9000,
        },
      ],
    },
    height: 280,
    width: "half" as const,
    useFor: ["Many nonnegative parts of one total, grouped by color."],
    avoidFor: ["Negative values or precise comparisons between similar values."],
    a11y: [
      "Arrows inspect every item; small items retain full labels and values in the tooltip and table.",
      "Enter selects; Escape dismisses; a tap inspects without dimming other items.",
    ],
    options: [
      {
        name: "groups",
        type: "string[]",
        description: "Group names in palette order.",
      },
      {
        name: "data",
        type: "{label,group,value}[]",
        description: "Nonnegative parts. Labels print only when they fit.",
      },
      {
        name: "legend",
        type: "boolean",
        description: "Group color meanings; true by default.",
      },
    ],
  },
];
