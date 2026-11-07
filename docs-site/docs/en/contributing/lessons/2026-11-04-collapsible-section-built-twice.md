### A collapsible detail section built its content twice

- **What happened:** Every collapsible `DetailPanel.Section` created its body twice; one copy was thrown away. Each child component ran its setup twice, so a child that loads data or registers listeners did that work twice.
- **Root cause:** The section resolved `props.children` once with `children()` for the non-collapsible case and then read `props.children` again in the collapsible body. In Solid every read of a component's `children` getter builds a new copy.
- **Error class:** A Solid component reads a `children` or other JSX prop more than once, for example as a condition and as content.
- **Guard:** `detail-sections.render.test.tsx` counts how often a footer and the children of a collapsible section are built and expects one; `DetailLinks` resolves its `footer` once with `children()`.
