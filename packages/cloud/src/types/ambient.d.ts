// Cross-app ambient module declarations. Every app's tsconfig includes this
// so apps can import non-TS assets (e.g. `import md from './x.md' with { type: "text" }`)
// without re-declaring the stub per-package.

declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.yaml" {
  const content: string;
  export default content;
}

declare module "*.sql" {
  const content: string;
  export default content;
}

declare module "*.sh" {
  const content: string;
  export default content;
}

declare module "*service-worker.js" {
  const content: string;
  export default content;
}

declare module "@babel/core" {
  export const types: typeof import("@babel/types");

  export function transformAsync(source: string, options: Record<string, unknown>): Promise<{ code?: string } | null>;
}
