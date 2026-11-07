import { WORLD_LAND_PATH, WORLD_MAP_HEIGHT, WORLD_MAP_WIDTH } from "./chart-map-data";
import {
  chartDatumSvg,
  clamp,
  computePlotArea,
  escapeXml,
  fmt,
  type MapOptions,
  type MapPoint,
  type MapViewport,
  mapRange,
  measureLegendHeight,
  normalizePadding,
  renderHeader,
  renderLegend,
  svgRoot,
} from "./svg";

const isMapPoint = (point: MapPoint): boolean =>
  Number.isFinite(point.latitude) &&
  Number.isFinite(point.longitude) &&
  point.latitude >= -90 &&
  point.latitude <= 90 &&
  point.longitude >= -180 &&
  point.longitude <= 180;

const MAP_MIN_ZOOM = 0;
const MAP_MAX_ZOOM = 5;

const normalizeMapViewport = (viewport: MapViewport | undefined): MapViewport => {
  const zoom = clamp(viewport && Number.isFinite(viewport.zoom) ? viewport.zoom : MAP_MIN_ZOOM, MAP_MIN_ZOOM, MAP_MAX_ZOOM);
  const zoomScale = 2 ** zoom;
  const latitudeLimit = 90 - 90 / zoomScale;
  const longitudeLimit = 180 - 180 / zoomScale;

  return {
    latitude: clamp(viewport && Number.isFinite(viewport.latitude) ? viewport.latitude : 0, -latitudeLimit, latitudeLimit),
    longitude: clamp(viewport && Number.isFinite(viewport.longitude) ? viewport.longitude : 0, -longitudeLimit, longitudeLimit),
    zoom,
  };
};

/** Render geographic point series over a dependency-free world land map. */
export function map(opts: MapOptions): string {
  const width = opts.width ?? 640;
  const height = opts.height ?? 340;
  const padding = normalizePadding(opts.padding ?? { top: 12, right: 16, bottom: 12, left: 16 });
  const header = renderHeader(width, opts.title, opts.subtitle);
  const legendItems = opts.legend
    ? opts.series.map((series, index) => ({
        label: series.label && series.label.length > 0 ? series.label : `Series ${index + 1}`,
        seriesIndex: index,
      }))
    : [];
  const legendHeight = measureLegendHeight(legendItems, width);
  const area = computePlotArea(width, height, padding, false, false, header.height, legendHeight);
  const availableWidth = Math.max(0, area.x1 - area.x0);
  const availableHeight = Math.max(0, area.y1 - area.y0);
  const scale = Math.max(0, Math.min(availableWidth / WORLD_MAP_WIDTH, availableHeight / WORLD_MAP_HEIGHT));
  const mapWidth = WORLD_MAP_WIDTH * scale;
  const mapHeight = WORLD_MAP_HEIGHT * scale;
  const mapX = area.x0 + (availableWidth - mapWidth) / 2;
  const mapY = area.y0 + (availableHeight - mapHeight) / 2;
  const viewport = normalizeMapViewport(opts.viewport);
  const zoomScale = 2 ** viewport.zoom;
  const projectedScale = scale * zoomScale;
  const centerWorldX = ((viewport.longitude + 180) / 360) * WORLD_MAP_WIDTH;
  const centerWorldY = ((90 - viewport.latitude) / 180) * WORLD_MAP_HEIGHT;

  const finitePoints = opts.series.flatMap((series, seriesIndex) =>
    series.data.map((point, index) => ({ point, seriesIndex, index })).filter(({ point }) => isMapPoint(point)),
  );

  let sizeMin = Number.POSITIVE_INFINITY;
  let sizeMax = Number.NEGATIVE_INFINITY;
  for (const { point } of finitePoints) {
    if (typeof point.size !== "number" || !Number.isFinite(point.size) || point.size < 0) {
      continue;
    }
    if (point.size < sizeMin) sizeMin = point.size;
    if (point.size > sizeMax) sizeMax = point.size;
  }
  const hasSizes = Number.isFinite(sizeMin) && Number.isFinite(sizeMax);
  const requestedSizeRange = opts.sizeRange ?? [3, 12];
  const firstRadius = Number.isFinite(requestedSizeRange[0]) ? Math.max(0, requestedSizeRange[0]) : 3;
  const secondRadius = Number.isFinite(requestedSizeRange[1]) ? Math.max(0, requestedSizeRange[1]) : 12;
  const radiusRange: [number, number] = firstRadius <= secondRadius ? [firstRadius, secondRadius] : [secondRadius, firstRadius];

  const body: string[] = [header.svg];
  if (scale > 0) {
    body.push(
      `<svg class="stdlib-chart-map-viewport" x="${fmt(mapX)}" y="${fmt(mapY)}" width="${fmt(mapWidth)}" height="${fmt(mapHeight)}" viewBox="0 0 ${fmt(mapWidth)} ${fmt(mapHeight)}" overflow="hidden">`,
      `<path class="stdlib-chart-map-land" fill-rule="evenodd" transform="translate(${fmt(mapWidth / 2)} ${fmt(mapHeight / 2)}) scale(${fmt(projectedScale)}) translate(${fmt(-centerWorldX)} ${fmt(-centerWorldY)})" d="${WORLD_LAND_PATH}"/>`,
    );

    for (const { point, seriesIndex, index } of finitePoints) {
      const pointWorldX = ((point.longitude + 180) / 360) * WORLD_MAP_WIDTH;
      const pointWorldY = ((90 - point.latitude) / 180) * WORLD_MAP_HEIGHT;
      const x = mapWidth / 2 + (pointWorldX - centerWorldX) * projectedScale;
      const y = mapHeight / 2 + (pointWorldY - centerWorldY) * projectedScale;
      const radius =
        hasSizes && typeof point.size === "number" && Number.isFinite(point.size) && point.size >= 0
          ? sizeMin === sizeMax
            ? (radiusRange[0] + radiusRange[1]) / 2
            : mapRange(point.size, [sizeMin, sizeMax], radiusRange)
          : 4;
      const title = point.label && point.label.length > 0 ? `<title>${escapeXml(point.label)}</title>` : "";
      body.push(
        chartDatumSvg(
          `<circle class="stdlib-chart-map-point stdlib-chart-series-${seriesIndex % 8}" cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(radius)}">${title}</circle>`,
          {
            index,
            seriesIndex,
            role: "point",
            label: point.label ?? opts.series[seriesIndex]?.label,
            anchor: [x, y],
            values: [
              { key: "latitude", value: point.latitude },
              { key: "longitude", value: point.longitude },
              ...(point.size !== undefined && Number.isFinite(point.size) ? [{ key: "size", value: point.size }] : []),
            ],
          },
          opts.inspect && x >= 0 && y >= 0 && x <= mapWidth && y <= mapHeight,
        ),
      );
    }
    body.push("</svg>");
  }

  if (finitePoints.length === 0) {
    body.push(
      `<text class="stdlib-chart-map-empty" x="${fmt(area.x0 + availableWidth / 2)}" y="${fmt(area.y0 + availableHeight / 2)}" text-anchor="middle" dominant-baseline="middle">No data</text>`,
    );
  }
  if (legendItems.length > 0) {
    body.push(renderLegend(legendItems, width, height - legendHeight).svg);
  }

  return svgRoot({ width, height, className: opts.className }, body.join(""));
}
