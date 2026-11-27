### A blank notebook greeted every person with an English welcome page

- **What happened:** A new blank notebook starts with a welcome page. For a person whose Cloud speaks German it said "Welcome!" and explained Markdown in English, while a notebook made from a template, in the same request, got German pages.
- **Root cause:** `notebooks.create` seeded the page from `service/hello.md`, the only welcome page there was, and never got the request's locale; `templates.instantiate` gets `getLocale(c)` and materializes its pages in it.
- **Error class:** Seeded content (a welcome page, an example, a default record) written in one language outside the catalogs, so it never follows the locale the rest of the request uses.
- **Guard:** `service/welcome.test.ts`: `welcomeMarkdown` gives the German page for `de` and `de-AT` and the English one for every other locale (red before, when there was only the English page), and both pages have the same parts. `POST /api/notebooks` passes `getLocale(c)` to `notebooks.create`, the same locale templates use.
