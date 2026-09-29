// The note PDF imports KaTeX's stylesheet as text, so the server bundle carries it.
declare module "katex/dist/katex.min.css" {
  const css: string;
  export default css;
}
