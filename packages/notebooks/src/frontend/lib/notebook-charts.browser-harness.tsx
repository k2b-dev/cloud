import { enhanceNotebookCharts } from "./notebook-charts";

declare global {
  interface Window {
    enhance(): void;
    restore(): void;
    chartClipboard?: string;
  }
}

const root = document.getElementById("notebook-book-content")!;
const cleanups: (() => void)[] = [];
window.enhance = () => cleanups.push(enhanceNotebookCharts(root, "de"));
window.restore = () =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
