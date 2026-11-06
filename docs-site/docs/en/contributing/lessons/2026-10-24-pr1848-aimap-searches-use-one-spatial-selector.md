### AiMap searches use one spatial selector

- **What happened:** AiMap place searches supplied both a circle and its center
  as `near`, which Core rejects before provider work.
- **Root cause:** Synthetic Geo fixtures accepted inputs without the public
  service's mutually exclusive spatial-selector rule.
- **Error class:** Consumer input violates a shared service invariant.
- **Guard:** AiMap service tests require a circle without `near`; named search
  tests trace the filter through the browser, service, GET/POST, and cache.
