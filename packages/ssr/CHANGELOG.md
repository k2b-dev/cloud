# Changelog

## [0.17.0](https://github.com/k2b-dev/cloud/compare/npm-ssr-v0.16.0...npm-ssr-v0.17.0) (2026-10-16)


### Features

* **ssr:** content-hashed island asset URLs and modulepreload for the page's island modules ([#1219](https://github.com/k2b-dev/cloud/issues/1219)) ([a254388](https://github.com/k2b-dev/cloud/commit/a254388aad6301f3d8afe57e41cd1e0a33fcdc9f))

## [0.16.0](https://github.com/k2b-dev/cloud/compare/npm-ssr-v0.15.1...npm-ssr-v0.16.0) (2026-10-15)


### Features

* **ssr:** mount island props without eval so pages run under a CSP without unsafe-eval ([#1106](https://github.com/k2b-dev/cloud/issues/1106)) ([06b0b42](https://github.com/k2b-dev/cloud/commit/06b0b4280a1dfa858ee4ee4be5b6922106659d72)), closes [#1080](https://github.com/k2b-dev/cloud/issues/1080)

## [0.15.1](https://github.com/k2b-dev/cloud/compare/npm-ssr-v0.15.0...npm-ssr-v0.15.1) (2026-10-13)


### Bug Fixes

* **ssr:** fail the build when an island imports another island ([#1069](https://github.com/k2b-dev/cloud/issues/1069)) ([aea0429](https://github.com/k2b-dev/cloud/commit/aea0429f2fef9acf03c5df01bb79056433d56b4b))
