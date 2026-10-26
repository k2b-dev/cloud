### Spread props never reached Pulse, Grids scanner and Weather settings islands

- **What happened:** Every Pulse base page showed "This section could not be displayed" after load; the browser threw `Cannot read properties of undefined (reading 'view')`.
- **Root cause:** The `@k2b/ssr` island transform serialized only named JSX attributes and skipped `JSXSpreadAttribute`, so `<PulseWorkspace {...workspaceProps} />` hydrated with `{}`. The Grids scanner and Weather settings islands used the same pattern.
- **Error class:** A build transform silently drops a supported JSX form, so server and browser receive different props.
- **Guard:** The transform merges spread and named attributes with Solid's `mergeProps`, as Solid renders them; a unit test renders a transformed page and decodes its `data-props`, including order, `undefined` fallback and an overridden getter.
