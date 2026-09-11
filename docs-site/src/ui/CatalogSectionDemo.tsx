import type { DemoSection } from "./demo-sections/types";

const markdownExample = `
  <h2>Rendered Markdown</h2>
  <p>This preview uses the same shared typography and content primitives as Cloud applications.</p>
  <pre><code>const source = "repository";</code></pre>
`;

export function CatalogSectionDemo(props: { demos: DemoSection; slug: string; search?: string }) {
  const render = props.demos[props.slug];

  if (!render) {
    return <p class="ui-demo-missing">No live example is registered for this page.</p>;
  }

  return (
    <div class="ui-demo-grid">
      {render({
        markdownHtml: markdownExample,
        search: props.search,
      })}
    </div>
  );
}
