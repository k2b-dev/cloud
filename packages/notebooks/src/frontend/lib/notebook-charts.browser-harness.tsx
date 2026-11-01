import { enhanceNotebookCharts } from "@k2b/editor/markdown/notebook-charts";
import { notebookChartOptions } from "../../lib/chart-options";

declare global {
  interface Window {
    enhance(): void;
    restore(): void;
    chartClipboard?: string;
  }
}

const root = document.getElementById("notebook-book-content")!;
const cleanups: (() => void)[] = [];
window.enhance = () => cleanups.push(enhanceNotebookCharts(root, "de", notebookChartOptions));
window.restore = () =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
