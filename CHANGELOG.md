# Changelog

release-please maintains this file from the next release on. Do not edit it by
hand; entries come from squash-commit titles on `main`.

## [0.10.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.9.1...cloud-v0.10.0) (2026-09-22)


### Features

* **ai:** show hosted reasoning streams and keep per-call timings and errors ([#122](https://github.com/k2b-dev/cloud/issues/122)) ([f6d781f](https://github.com/k2b-dev/cloud/commit/f6d781fadcad4c2ef426a3ece2d280c0a9c9abc4))
* **assistant:** write ODS workbooks in code mode ([#113](https://github.com/k2b-dev/cloud/issues/113)) ([163e285](https://github.com/k2b-dev/cloud/commit/163e28514ffe103741ce5e0c404e16034a48580b)), closes [#112](https://github.com/k2b-dev/cloud/issues/112)
* **grids:** package query-selected document files as a streamed ZIP Document ([#117](https://github.com/k2b-dev/cloud/issues/117)) ([93569d4](https://github.com/k2b-dev/cloud/commit/93569d4f7e83f32e9f52653d1e3ecce46a002daa))
* **grids:** return download links for every generated document ([#114](https://github.com/k2b-dev/cloud/issues/114)) ([5e3cbe2](https://github.com/k2b-dev/cloud/commit/5e3cbe22cefdc5f14d2c10623fc60c057f2b6a73))
* **grids:** share any document format through explicit workflow links ([#115](https://github.com/k2b-dev/cloud/issues/115)) ([b26020e](https://github.com/k2b-dev/cloud/commit/b26020e4b830bf5357352b1c04f3ce7c69ff9c5f))


### Bug Fixes

* **ai:** resolve Unicode-equivalent file names consistently ([#121](https://github.com/k2b-dev/cloud/issues/121)) ([70a0d78](https://github.com/k2b-dev/cloud/commit/70a0d78c548cb2db8212eef2605b93302ed7e207)), closes [#119](https://github.com/k2b-dev/cloud/issues/119)

## [0.9.1](https://github.com/k2b-dev/cloud/compare/cloud-v0.9.0...cloud-v0.9.1) (2026-09-22)


### Bug Fixes

* **accounts:** keep user deletion from failing after the row is gone ([#111](https://github.com/k2b-dev/cloud/issues/111)) ([a6b67d7](https://github.com/k2b-dev/cloud/commit/a6b67d77db0c25a535fced0e616cb50db6d61b05)), closes [#107](https://github.com/k2b-dev/cloud/issues/107)
* **cloud:** give the mobile launchpad the full sheet when an app has no menu ([#106](https://github.com/k2b-dev/cloud/issues/106)) ([c58af23](https://github.com/k2b-dev/cloud/commit/c58af233e73f3ee1fe355b9b94c0b54b35742109)), closes [#101](https://github.com/k2b-dev/cloud/issues/101)
* **filesv2:** resolve bundled document templates and name the failing step ([#104](https://github.com/k2b-dev/cloud/issues/104)) ([18bd9fd](https://github.com/k2b-dev/cloud/commit/18bd9fdeb38df023286ed8ccc67b54576fb2eb48)), closes [#100](https://github.com/k2b-dev/cloud/issues/100)
* **mail:** treat the advertised RFC822.SIZE as advisory during hydration ([#105](https://github.com/k2b-dev/cloud/issues/105)) ([eddcf92](https://github.com/k2b-dev/cloud/commit/eddcf92987c8bf90c92698de574fa1a0f2b4c4e7)), closes [#99](https://github.com/k2b-dev/cloud/issues/99)
* **ui:** align paired field controls regardless of description length ([#110](https://github.com/k2b-dev/cloud/issues/110)) ([6ddad3e](https://github.com/k2b-dev/cloud/commit/6ddad3ed5267353c72267880a2f2eb05657acd7b)), closes [#92](https://github.com/k2b-dev/cloud/issues/92)
* **ui:** show dialog and sheet focus rings only for keyboard focus ([#103](https://github.com/k2b-dev/cloud/issues/103)) ([98a8ae7](https://github.com/k2b-dev/cloud/commit/98a8ae74a9c52db080d0fd8049ddb4b07ad6e1c7)), closes [#102](https://github.com/k2b-dev/cloud/issues/102)

## [0.9.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.8.0...cloud-v0.9.0) (2026-09-22)


### Features

* **cloud:** ship server-side application assets with the bundle ([#73](https://github.com/k2b-dev/cloud/issues/73)) ([52f818c](https://github.com/k2b-dev/cloud/commit/52f818cb4a627e55ee77e140493391357c6fd15e)), closes [#66](https://github.com/k2b-dev/cloud/issues/66)
* **core:** request sign-in links with the username ([#64](https://github.com/k2b-dev/cloud/issues/64)) ([e487187](https://github.com/k2b-dev/cloud/commit/e487187acc14f5fc57ebcada1f7fb85c236bcce2)), closes [#62](https://github.com/k2b-dev/cloud/issues/62)
* **filesv2:** label the personal base "My files" and keep technical names as meta ([#87](https://github.com/k2b-dev/cloud/issues/87)) ([5429a4a](https://github.com/k2b-dev/cloud/commit/5429a4ac21618fced68c5c3571bd578b849acfed)), closes [#84](https://github.com/k2b-dev/cloud/issues/84)
* **filesv2:** name the app Files and mark the previous app as legacy ([#80](https://github.com/k2b-dev/cloud/issues/80)) ([7512a85](https://github.com/k2b-dev/cloud/commit/7512a856137be61d19584d20e0fda82bdf81dfb8))


### Bug Fixes

* **cloud:** make revoke-during-verification API key test deterministic ([#58](https://github.com/k2b-dev/cloud/issues/58)) ([5caf896](https://github.com/k2b-dev/cloud/commit/5caf896ea3dbe3ca98bf97ebe4908c1516bbf6af))
* **core:** allow decimal AI model prices ([#75](https://github.com/k2b-dev/cloud/issues/75)) ([603ab9e](https://github.com/k2b-dev/cloud/commit/603ab9e278a6ca6660e888138a5421db98f5ad75)), closes [#72](https://github.com/k2b-dev/cloud/issues/72)
* **filesv2:** hide intentionally disabled storage areas from user notices ([#76](https://github.com/k2b-dev/cloud/issues/76)) ([2c11327](https://github.com/k2b-dev/cloud/commit/2c1132785a5c3bb564691216cd94a8e2f4a468e0)), closes [#69](https://github.com/k2b-dev/cloud/issues/69)
* **filesv2:** show search as a sidebar item above Recent ([#88](https://github.com/k2b-dev/cloud/issues/88)) ([c9c8869](https://github.com/k2b-dev/cloud/commit/c9c886969754d6574368cf36c75be416294433c9)), closes [#85](https://github.com/k2b-dev/cloud/issues/85)
* **filesv2:** show the external-edit notice once instead of a permanent banner ([#68](https://github.com/k2b-dev/cloud/issues/68)) ([f70ba38](https://github.com/k2b-dev/cloud/commit/f70ba38e3cb01c678811893463014214b80fba01)), closes [#67](https://github.com/k2b-dev/cloud/issues/67)
* **mail:** derive the provider identity from stable IMAP ID fields ([#96](https://github.com/k2b-dev/cloud/issues/96)) ([30dc3ff](https://github.com/k2b-dev/cloud/commit/30dc3ffd377d265424207726873edea6707554fd)), closes [#94](https://github.com/k2b-dev/cloud/issues/94)
* **mail:** give the provider settings lookup its own row in the account section ([#82](https://github.com/k2b-dev/cloud/issues/82)) ([3f5d173](https://github.com/k2b-dev/cloud/commit/3f5d17325fb629e743c2d7b8f977597a006dd452))
* **mail:** keep the workspace route relative across SSR hydration ([#90](https://github.com/k2b-dev/cloud/issues/90)) ([ccbd143](https://github.com/k2b-dev/cloud/commit/ccbd143df212065180c1c860f7e4cbe006cbfe54)), closes [#86](https://github.com/k2b-dev/cloud/issues/86)
* **notebooks:** keep the awareness topic's dedupe window within its retention ([#74](https://github.com/k2b-dev/cloud/issues/74)) ([d9ef8dc](https://github.com/k2b-dev/cloud/commit/d9ef8dc2af06a068e10f566ece8f2312c255a175)), closes [#70](https://github.com/k2b-dev/cloud/issues/70)
* **release:** boot the smoke stack with the core secrets and skip npm versions already published ([#56](https://github.com/k2b-dev/cloud/issues/56)) ([a739cf8](https://github.com/k2b-dev/cloud/commit/a739cf83e38da563139b228514151da5666ad3dc))
* **release:** pin Cosign 2 for the CLI signature and allow finishing a release again ([#54](https://github.com/k2b-dev/cloud/issues/54)) ([8c446ee](https://github.com/k2b-dev/cloud/commit/8c446ee196621acfafb33708fcebd5b338bff177))
* replace session advisory locks with pooling-safe coordination ([#77](https://github.com/k2b-dev/cloud/issues/77)) ([21834e3](https://github.com/k2b-dev/cloud/commit/21834e394cd411b1037df95bba6444a1c8656a6d))
* **spaces:** honour --completed when adding a checklist entry ([#95](https://github.com/k2b-dev/cloud/issues/95)) ([d538e95](https://github.com/k2b-dev/cloud/commit/d538e951dc98d793efa9be6322a05432478647df)), closes [#93](https://github.com/k2b-dev/cloud/issues/93)
* **ui:** keep check and switch inputs inside their label ([#71](https://github.com/k2b-dev/cloud/issues/71)) ([3a451c0](https://github.com/k2b-dev/cloud/commit/3a451c04da7741f3ba49c3e63ae69d4fb9015cb2)), closes [#63](https://github.com/k2b-dev/cloud/issues/63)
* **ui:** keep the workspace sidebar scroll position across navigations ([#81](https://github.com/k2b-dev/cloud/issues/81)) ([fe52d9d](https://github.com/k2b-dev/cloud/commit/fe52d9dedb6555b40a009e44ebbc57faf228176e)), closes [#78](https://github.com/k2b-dev/cloud/issues/78)

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
