import { type Metric, onCLS, onINP, onLCP } from "web-vitals";

const script = document.querySelector<HTMLScriptElement>("script[data-cloud-web-vitals]");
const appId = script?.dataset.appId;
const routeTemplate = script?.dataset.routeTemplate;

if (appId && routeTemplate) {
  const report = ({ name, value, id, navigationType }: Metric) => {
    const entry = performance.getEntriesByType("navigation")[0];
    const serverTiming: Record<string, number> = {};
    const timings =
      typeof PerformanceNavigationTiming !== "undefined" && entry instanceof PerformanceNavigationTiming ? entry.serverTiming : [];
    for (const timing of timings) {
      if (["auth", "settings", "runtime", "ssr_data", "ssr_finalize", "ssr_render"].includes(timing.name)) {
        serverTiming[timing.name] = (serverTiming[timing.name] ?? 0) + timing.duration;
      }
    }
    // Never serialize Metric.entries: they can contain page text, elements and private URLs.
    const body = JSON.stringify({ appId, routeTemplate, name, value, id, navigationType, serverTiming });
    navigator.sendBeacon("/api/me/web-vitals", new Blob([body], { type: "application/json" }));
  };
  onLCP(report);
  onINP(report);
  onCLS(report);
}
