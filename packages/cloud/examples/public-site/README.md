# Standalone public-site example

A fictional bakery website, **Lindenhof Bakery**, served on its own domain
through `app.public`. It shows the app SEO checklist from *Public site of an
app* (`build/public-surface.md`) in about 250 lines: an English and a German
page linked through `hreflang`, absolute canonical URLs taken from the
visitor's public address, Open Graph and JSON-LD, `robots.txt` naming the
sitemap, a sitemap of canonical addresses, a permanent redirect, a `410` for a
removed page, an ETag on every page, a hashed logo with immutable caching, and
one island for the only browser interaction.

It is a standalone consumer, not a Cloud workspace application, and needs no
entry in Cloud's Compose files. Copy this directory into its own repository,
pin the Cloud release that contains `public: true` and `app.publicSsr()`, then:

```sh
bun install
bun run typecheck
bun run build
```

Deploy it like any Cloud application, then assign the domain:

```sh
cld admin apps domains add public-site www.example.com
```

`src/site.tsx` holds the public routes, `src/Page.tsx` the page, and
`src/ShareButton.island.tsx` the island. `src/index.ts` adds a one-line page on
the Cloud host that tells administrators where the site runs.

Inside the Cloud monorepo, `test/site.test.ts` checks the SEO checklist on the
rendered public surface, and `bun scripts/lighthouse-public-site.ts` measures
the production build through the gateway's app-domain path with Lighthouse
(SEO 100 and mobile performance 95 are required).
