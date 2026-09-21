# Changelog

release-please maintains this file from the next release on. Do not edit it by
hand; entries come from squash-commit titles on `main`.

## [0.8.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.7.0...cloud-v0.8.0) (2026-09-21)


### Features

* adopt a release train with gated CI and one configuration model ([7fa46ac](https://github.com/k2b-dev/cloud/commit/7fa46ac88f7af9fe5c58152beae2bda5180fcd55))
* **assistant:** run scheduled code with task-scoped grants ([#33](https://github.com/k2b-dev/cloud/issues/33)) ([391572e](https://github.com/k2b-dev/cloud/commit/391572e5c62341f735bea12bc9f099758531691b)), closes [#15](https://github.com/k2b-dev/cloud/issues/15)
* **filesv2:** download private files from resource references ([35e3d7f](https://github.com/k2b-dev/cloud/commit/35e3d7f834d2ddbc27bcaecc2d3f2d80038b4489))
* **grids:** download document folders and expose authenticated file links ([#23](https://github.com/k2b-dev/cloud/issues/23)) ([fb2725a](https://github.com/k2b-dev/cloud/commit/fb2725afb463f42224f8f616d9684873641d8837))
* **grids:** select and open generic Cloud resource references ([#26](https://github.com/k2b-dev/cloud/issues/26)) ([622448c](https://github.com/k2b-dev/cloud/commit/622448cc51cccc5c35e2c1808f61220087b7aff6))


### Bug Fixes

* **ai:** rank fuzzy name matches above description hits in skill search ([#35](https://github.com/k2b-dev/cloud/issues/35)) ([92b620f](https://github.com/k2b-dev/cloud/commit/92b620f375afbf842d14a8993a5fd969511e8d74)), closes [#34](https://github.com/k2b-dev/cloud/issues/34)
* **ci:** first nightly run findings ([#21](https://github.com/k2b-dev/cloud/issues/21)) ([72e07eb](https://github.com/k2b-dev/cloud/commit/72e07eb3fa110ba118c131bbfa4663ee088e3671)), closes [#11](https://github.com/k2b-dev/cloud/issues/11)
* **ci:** ship the test environment mapping in the Cloud Login image build ([#50](https://github.com/k2b-dev/cloud/issues/50)) ([732dc8c](https://github.com/k2b-dev/cloud/commit/732dc8c40d768f152b961832026889ef91274330))
* **cloud:** re-enable the request-cache outage test ([#24](https://github.com/k2b-dev/cloud/issues/24)) ([03d6b49](https://github.com/k2b-dev/cloud/commit/03d6b49963680708d29508850f91c798c44ea7ea)), closes [#9](https://github.com/k2b-dev/cloud/issues/9)
* **core:** answer 401 for an invalid emergency recovery token ([#30](https://github.com/k2b-dev/cloud/issues/30)) ([40d45fd](https://github.com/k2b-dev/cloud/commit/40d45fdc2c1072009e5103710f0ab42a35d897c4)), closes [#4](https://github.com/k2b-dev/cloud/issues/4)
* **grids:** preserve relation labels across workspace rendering ([#17](https://github.com/k2b-dev/cloud/issues/17)) ([fbf7256](https://github.com/k2b-dev/cloud/commit/fbf72566fee468e1ce17d047dc911ded54a94e3d))
* **notebooks:** keep the ordering test's notes in different partitions ([#48](https://github.com/k2b-dev/cloud/issues/48)) ([ccd62f7](https://github.com/k2b-dev/cloud/commit/ccd62f7f1611ef29d8672d300fc34db04334d5cd)), closes [#42](https://github.com/k2b-dev/cloud/issues/42)
* **release:** bump workspace dependents when a published package releases ([#51](https://github.com/k2b-dev/cloud/issues/51)) ([51f2b83](https://github.com/k2b-dev/cloud/commit/51f2b834194abb19a0dec6b73d3dc82d791c30d8))
* **release:** start the changelog at the 0.7.0 release commit ([#36](https://github.com/k2b-dev/cloud/issues/36)) ([153f340](https://github.com/k2b-dev/cloud/commit/153f34035f046b32ea252cf749449bb0f0947fe3))
* **test:** bind the default Redis handle to the test target before Bun starts ([#43](https://github.com/k2b-dev/cloud/issues/43)) ([9b3a0da](https://github.com/k2b-dev/cloud/commit/9b3a0daba07943eea255d004b8cca8458a6c65e7)), closes [#39](https://github.com/k2b-dev/cloud/issues/39)

## 0.7.0

The last release before automated releases. It shipped `@k2b/cloud` 0.7.0,
`@k2b/ui` 0.3.0, the Cloud CLI 0.1.0, and the matching application images.
