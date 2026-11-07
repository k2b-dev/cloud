### The website image stopped building after a browser test joined the site

- **What happened:** After the chart showcase (#2747) merged, every `main.yml` run failed in the `cloud-website` image build, which blocked the sha images and the next release. The PR gate had passed.
- **Root cause:** `docs-site/Dockerfile` ran the full `docs-site` typecheck, which includes `*.test.ts`. The new `charts-showcase.browser.test.ts` imports `packages/ui/test/browser`, which is not in the image's COPY set. The PR gate never built that image: the `images` job builds only the Core, Gateway, Cloud Login, and Notes images.
- **Error class:** A release image has its own narrow COPY set and build-time checks, and only `main.yml` builds it. A file that the checkout has but the image context lacks fails first on `main`.
- **Guard:** The image typechecks the site with `docs-site/tsconfig.build.json`, which leaves out the tests. The PR `docs` job typechecks the tests and builds the website image. The `ci-image-builds` repository rule fails when `ci.yml` does not build a release image Dockerfile from `scripts/workspace.ts`.
