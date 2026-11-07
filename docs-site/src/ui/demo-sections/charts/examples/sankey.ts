/** Fictional newsletter paths; compatible with the showcase registry's ChartShowcaseExample shape. */
export const sankeyExamples = [
  {
    id: "sankey-newsletter",
    kind: "sankey",
    question: "flow",
    title: "Paths after the click",
    summary: "Follow readers from their first click to a visit, signup or exit. Node totals keep losses visible.",
    spec: {
      kind: "sankey",
      title: "Paths after the click",
      nodes: [
        { id: "click", label: "Clicked", tone: "blue" },
        { id: "article", label: "Article", tone: "green" },
        { id: "offer", label: "Offer", tone: "violet" },
        { id: "signup", label: "Signed up", tone: "in" },
        { id: "left", label: "Left", tone: "muted" },
      ],
      links: [
        { source: "click", target: "article", value: 520 },
        { source: "click", target: "offer", value: 280 },
        { source: "article", target: "signup", value: 140 },
        { source: "offer", target: "signup", value: 180 },
        { source: "article", target: "left", value: 320 },
        { source: "offer", target: "left", value: 80 },
      ],
    },
    height: 280,
    width: "twoThirds",
    useFor: ["Converging and diverging flows with a common unit."],
    avoidFor: ["Cycles or unrelated measures."],
    a11y: [
      "Arrow keys inspect nodes and flows; Home/End jump, Enter pins and Escape dismisses.",
      "A narrow chart starts at the sources and scrolls horizontally. The table includes every node and link.",
    ],
    options: [
      { name: "nodes", type: "{id,label,tone?}[]", description: "Unique ids; tone colors outgoing flows." },
      { name: "links", type: "{source,target,value}[]", description: "Positive values and existing endpoints; no cycles." },
      { name: "legend", type: "{tone,label}[]", description: "Explicit color meanings; wraps within the plot width." },
    ],
  },
];
