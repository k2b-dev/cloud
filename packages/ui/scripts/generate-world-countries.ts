/**
 * Generates `src/content/world-countries.ts`, the country shapes behind `CountryMap`.
 *
 *   bun packages/ui/scripts/generate-world-countries.ts <countries-110m.json> <countries-50m.json> <codes.json>
 *
 * Inputs: `countries-*.json` from the npm package world-atlas@2 (Natural Earth, public domain) and
 * `codes.json` from i18n-iso-countries@7 (ISO numeric to alpha-2). Unpack them outside the repository;
 * nothing here runs at build time. Countries too small for the 110m shapes become dots from the 50m data.
 */
type Topology = {
  transform: { scale: [number, number]; translate: [number, number] };
  arcs: [number, number][][];
  objects: {
    countries: { geometries: { id?: string; type: string; arcs: number[][] | number[][][]; properties: { name: string } }[] };
  };
};

const args = process.argv.slice(2);
if (args.length !== 3 || args.includes("--help")) {
  console.log("Usage: bun packages/ui/scripts/generate-world-countries.ts <countries-110m.json> <countries-50m.json> <codes.json>");
  process.exit(args.includes("--help") ? 0 : 1);
}
const [shapesPath, dotsPath, codesPath] = args as [string, string, string];
const alpha2 = new Map((JSON.parse(await Bun.file(codesPath).text()) as string[][]).map((row) => [row[2]!, row[0]!]));
// Natural Earth leaves these without an ISO number.
const namedCodes: Record<string, string> = { Kosovo: "XK" };
const WIDTH = 1000;
const HEIGHT = 450;

/** Natural Earth I projection (Šavrič et al.), scaled to the viewBox. */
const project = ([longitude, latitude]: [number, number]): [number, number] => {
  const lambda = (longitude * Math.PI) / 180;
  const phi = (latitude * Math.PI) / 180;
  const p2 = phi * phi;
  const p4 = p2 * p2;
  const x = lambda * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
  const y = phi * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)));
  const scale = WIDTH / (2 * 2.7347);
  return [WIDTH / 2 + x * scale, 262 - y * scale];
};

const decodeArcs = (topology: Topology) =>
  topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]): [number, number] => {
      x += dx;
      y += dy;
      return [
        x * topology.transform.scale[0] + topology.transform.translate[0],
        y * topology.transform.scale[1] + topology.transform.translate[1],
      ];
    });
  });

const ringPoints = (arcs: [number, number][][], ring: number[]) => {
  const points: [number, number][] = [];
  for (const index of ring) {
    const arc = index < 0 ? [...arcs[~index]!].reverse() : arcs[index]!;
    points.push(...(points.length ? arc.slice(1) : arc));
  }
  return points;
};

const rings = (geometry: Topology["objects"]["countries"]["geometries"][number]) =>
  (geometry.type === "Polygon" ? [geometry.arcs as number[][]] : (geometry.arcs as number[][][])).flat();

const code = (geometry: Topology["objects"]["countries"]["geometries"][number]) =>
  (geometry.id && alpha2.get(geometry.id)) || namedCodes[geometry.properties.name];

/** Keep the part of a ring on one side of a meridian (Sutherland-Hodgman). */
const clip = (points: [number, number][], limit: number, keep: (longitude: number) => boolean) => {
  const result: [number, number][] = [];
  for (const [index, point] of points.entries()) {
    const next = points[(index + 1) % points.length]!;
    if (keep(point[0])) result.push(point);
    if (keep(point[0]) !== keep(next[0]))
      result.push([limit, point[1] + ((limit - point[0]) / (next[0] - point[0])) * (next[1] - point[1])]);
  }
  return result;
};

/** The atlas stitches shapes across the 180th meridian; a flat map draws them in two parts. */
const splitAtAntimeridian = (points: [number, number][]): [number, number][][] => {
  const unwrapped: [number, number][] = [];
  for (const [longitude, latitude] of points) {
    const previous = unwrapped.at(-1)?.[0] ?? longitude;
    unwrapped.push([longitude + 360 * Math.round((previous - longitude) / 360), latitude]);
  }
  const longitudes = unwrapped.map(([longitude]) => longitude);
  const limit = Math.max(...longitudes) > 180 ? 180 : Math.min(...longitudes) < -180 ? -180 : null;
  if (limit === null) return [points];
  const inside = clip(unwrapped, limit, (longitude) => Math.abs(longitude) <= 180);
  const outside = clip(unwrapped, limit, (longitude) => Math.abs(longitude) > 180).map(([longitude, latitude]): [number, number] => [
    longitude - Math.sign(limit) * 360,
    latitude,
  ]);
  return [inside, outside].filter((part) => part.length > 2);
};

const round = (value: number) => Math.round(value * 10) / 10;
const ringPath = (points: [number, number][]) => {
  let d = "";
  let [px, py] = [0, 0];
  for (const [index, point] of points.entries()) {
    const [x, y] = project(point).map(round) as [number, number];
    if (index === 0) d += `M${x} ${y}`;
    else if (x !== px || y !== py) d += `l${round(x - px)} ${round(y - py)}`;
    [px, py] = [x, y];
  }
  return `${d}z`;
};

const shapesTopology = JSON.parse(await Bun.file(shapesPath).text()) as Topology;
const shapeArcs = decodeArcs(shapesTopology);
const shapes = new Map<string, string>();
for (const geometry of shapesTopology.objects.countries.geometries) {
  const country = code(geometry);
  if (!country || country === "AQ") continue;
  shapes.set(
    country,
    (shapes.get(country) ?? "") +
      rings(geometry)
        .flatMap((ring) => splitAtAntimeridian(ringPoints(shapeArcs, ring)))
        .map(ringPath)
        .join(""),
  );
}

const dotsTopology = JSON.parse(await Bun.file(dotsPath).text()) as Topology;
const dotArcs = decodeArcs(dotsTopology);
const dots: [string, number, number][] = [];
for (const geometry of dotsTopology.objects.countries.geometries) {
  const country = code(geometry);
  if (!country || country === "AQ" || shapes.has(country)) continue;
  // The largest ring's vertex mean is close enough for a dot on a world map.
  const ring = rings(geometry)
    .map((item) => ringPoints(dotArcs, item))
    .sort((a, b) => b.length - a.length)[0]!;
  const [x, y] = project([
    ring.reduce((sum, point) => sum + point[0], 0) / ring.length,
    ring.reduce((sum, point) => sum + point[1], 0) / ring.length,
  ]);
  dots.push([country, round(x), round(y)]);
}

const sorted = [...shapes.entries()].sort(([a], [b]) => a.localeCompare(b));
dots.sort(([a], [b]) => a.localeCompare(b));
const output = `// Generated by packages/ui/scripts/generate-world-countries.ts; do not edit.
// Country geometry: Natural Earth (public domain) through world-atlas, Natural Earth I projection.
export const WORLD_MAP_VIEW_WIDTH = ${WIDTH};
export const WORLD_MAP_VIEW_HEIGHT = ${HEIGHT};
/** ISO 3166-1 alpha-2 code and SVG path. */
export const WORLD_COUNTRY_SHAPES: readonly (readonly [string, string])[] = [
${sorted.map(([country, d]) => `  ["${country}", "${d}"],`).join("\n")}
];
/** Countries too small for a shape: ISO 3166-1 alpha-2 code, x and y. */
export const WORLD_COUNTRY_DOTS: readonly (readonly [string, number, number])[] = [
${dots.map(([country, x, y]) => `  ["${country}", ${x}, ${y}],`).join("\n")}
];
`;
await Bun.write(new URL("../src/content/world-countries.ts", import.meta.url), output);
console.log(`${sorted.length} shapes, ${dots.length} dots, ${output.length} bytes`);
