import { inspectA11y } from "./common";
import type { ChartShowcaseExample } from "./types";

const examples: ChartShowcaseExample[] = [
  {
    id: "map-shops",
    kind: "map",
    question: "distribution",
    title: "Map",
    summary: "Places on a world map, sized by their value. Pan, zoom and reset keep the places in view.",
    spec: {
      kind: "map",
      series: [
        {
          label: "Orders",
          data: [
            { latitude: 52.52, longitude: 13.405, label: "Berlin", size: 1840 },
            { latitude: 48.137, longitude: 11.575, label: "Munich", size: 1260 },
            { latitude: 47.376, longitude: 8.541, label: "Zurich", size: 720 },
            { latitude: 48.208, longitude: 16.373, label: "Vienna", size: 690 },
            { latitude: 52.37, longitude: 4.895, label: "Amsterdam", size: 410 },
            { latitude: 48.857, longitude: 2.352, label: "Paris", size: 380 },
          ],
        },
      ],
      interactive: true,
    },
    height: 300,
    useFor: ["Where things happen, when the place itself matters.", "A handful of places with a value each."],
    avoidFor: ["Ranking countries by a value; a sorted bar list is easier to read.", "Values per country area; use the country map."],
    a11y: [
      ...inspectA11y.slice(0, 1),
      "Arrow keys pan the map; Alt with arrow keys inspects the places; plus, minus and reset buttons zoom.",
      ...inspectA11y.slice(1),
    ],
    options: [
      {
        name: "series",
        type: "{ label?, data: { latitude, longitude, label?, size? }[] }[]",
        description: "Places; size scales its point.",
      },
      { name: "interactive", type: "boolean", description: "Adds pan, zoom and reset controls." },
      { name: "zoomFocus", type: "{ latitude, longitude }", description: "Where zooming in from the world view goes; Europe by default." },
    ],
  },
];

export default examples;
