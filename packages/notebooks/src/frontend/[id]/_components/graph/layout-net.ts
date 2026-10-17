import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import type { GraphModel } from "./model";

export type NetPoint = { x: number; y: number };
/** d3's default cooling reaches its minimum alpha after 300 ticks; the layout runs exactly that, headless, once. */
const TICKS = 300;
/** Collision only matters once the clusters have formed, so it joins for the last ticks, which saves about a third.
 * A Barnes-Hut theta of 1.2 instead of 0.9 roughly halves the repulsion cost and leaves the clusters unchanged. */
const COLLIDE_TICKS = 100;
export function nodeRadius(deg: number): number {
  return Math.min(11, 3.6 + Math.sqrt(deg) * 1.55);
}
export function seededRandom(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** One headless simulation; `step` advances it by single ticks, so slicing never changes the result. */
function createLayout(model: GraphModel) {
  const random = seededRandom(11);
  const radius = 210 * Math.sqrt(model.notes.length / 50);
  const areaCount = model.areas.length - 1;
  const nodes = model.notes.map((note) => {
    const angle = -Math.PI / 2 + ((note.area.index - 1) / Math.max(1, areaCount)) * 2 * Math.PI;
    const ax = note.area.index === 0 ? 0 : Math.cos(angle) * radius;
    const ay = note.area.index === 0 ? 0 : Math.sin(angle) * radius;
    return {
      id: note.id,
      x: ax + (random() - 0.5) * 60,
      y: ay + (random() - 0.5) * 60,
      ax,
      ay,
      strength: note.area.index === 0 ? 0.01 : 0.035,
      r: nodeRadius(note.deg),
    };
  });
  type Node = (typeof nodes)[number];
  const simulation = forceSimulation(nodes).stop().randomSource(seededRandom(11));
  simulation
    .force(
      "x",
      forceX<Node>((node) => node.ax).strength((node) => node.strength),
    )
    .force(
      "y",
      forceY<Node>((node) => node.ay).strength((node) => node.strength),
    )
    .force(
      "link",
      forceLink<Node, GraphModel["edges"][number]>(model.edges.map((edge) => ({ ...edge })))
        .id((node) => node.id)
        .distance((edge) => (edge.sameArea ? 40 : 150))
        .strength((edge) => (edge.sameArea ? 0.7 : 0.004)),
    )
    .force("charge", forceManyBody<Node>().strength(-45).distanceMax(400).theta(1.2));
  let ticks = 0;
  return {
    done: () => ticks >= TICKS,
    step: () => {
      if (ticks === TICKS - COLLIDE_TICKS)
        simulation.force(
          "collide",
          forceCollide<Node>((node) => node.r + 8),
        );
      simulation.tick(1);
      ticks++;
    },
    positions: () => new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y }])),
  };
}

export function layoutNetwork(model: GraphModel): Map<string, NetPoint> {
  const layout = createLayout(model);
  while (!layout.done()) layout.step();
  return layout.positions();
}

/** Time the browser may spend on the layout before it paints and handles input again. */
const SLICE_MS = 12;

/**
 * The same layout, computed in slices of about 12 ms, so a large notebook never blocks the page (Close keeps working).
 * Resolves with exactly the positions of `layoutNetwork`, or null when the signal aborts.
 */
export async function layoutNetworkInSlices(model: GraphModel, signal: AbortSignal): Promise<Map<string, NetPoint> | null> {
  const layout = createLayout(model);
  while (!layout.done()) {
    const start = performance.now();
    while (!layout.done() && performance.now() - start < SLICE_MS) layout.step();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (signal.aborted) return null;
  }
  return layout.positions();
}
