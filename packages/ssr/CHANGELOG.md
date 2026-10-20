# Changelog

## [0.19.0](https://github.com/k2b-dev/cloud/compare/npm-ssr-v0.18.0...npm-ssr-v0.19.0) (2026-10-20)


### Features

* **ssr:** give history one owner, so Back and Forward swap between server pages and islands keep their own entries ([#1616](https://github.com/k2b-dev/cloud/issues/1616)) ([50192a8](https://github.com/k2b-dev/cloud/commit/50192a883d417c6136659de59e86cf9f320719cf))
* **ssr:** let islands veto a page swap, and roll Back and Forward back when they do ([#1628](https://github.com/k2b-dev/cloud/issues/1628)) ([fc6520f](https://github.com/k2b-dev/cloud/commit/fc6520fa955a3b184f3191f8434f1d9225fa899a))

## [0.18.0](https://github.com/k2b-dev/cloud/compare/npm-ssr-v0.17.0...npm-ssr-v0.18.0) (2026-10-20)


### Features

* **ssr:** let nav swap a server-rendered page into the content column, newest navigation wins, any failure loads the document ([#1589](https://github.com/k2b-dev/cloud/issues/1589)) ([353e3fa](https://github.com/k2b-dev/cloud/commit/353e3fa069b2e16825ccd5e4a3ac8a0c7db5260a))
* **ssr:** mount islands in inserted content, and on removal dispose them and close open dialogs ([#1570](https://github.com/k2b-dev/cloud/issues/1570)) ([1c176dd](https://github.com/k2b-dev/cloud/commit/1c176dd731b4854629e5bd39bf7737f32c04e8fe)), closes [#1560](https://github.com/k2b-dev/cloud/issues/1560)

## [0.17.0](https://github.com/k2b-dev/cloud/compare/npm-ssr-v0.16.0...npm-ssr-v0.17.0) (2026-10-16)


### Features

* **ssr:** content-hashed island asset URLs and modulepreload for the page's island modules ([#1219](https://github.com/k2b-dev/cloud/issues/1219)) ([a254388](https://github.com/k2b-dev/cloud/commit/a254388aad6301f3d8afe57e41cd1e0a33fcdc9f))

## [0.16.0](https://github.com/k2b-dev/cloud/compare/npm-ssr-v0.15.1...npm-ssr-v0.16.0) (2026-10-15)


### Features

* **ssr:** mount island props without eval so pages run under a CSP without unsafe-eval ([#1106](https://github.com/k2b-dev/cloud/issues/1106)) ([06b0b42](https://github.com/k2b-dev/cloud/commit/06b0b4280a1dfa858ee4ee4be5b6922106659d72)), closes [#1080](https://github.com/k2b-dev/cloud/issues/1080)

## [0.15.1](https://github.com/k2b-dev/cloud/compare/npm-ssr-v0.15.0...npm-ssr-v0.15.1) (2026-10-13)


### Bug Fixes

* **ssr:** fail the build when an island imports another island ([#1069](https://github.com/k2b-dev/cloud/issues/1069)) ([aea0429](https://github.com/k2b-dev/cloud/commit/aea0429f2fef9acf03c5df01bb79056433d56b4b))
