// Loaded on demand by image inputs. A named re-export keeps the import narrow: `import("@k2b/stdlib/browser")` would
// load every browser utility and make island builds keep unused barrel modules in static chunks (#3504).
export { img } from "@k2b/stdlib/browser";
