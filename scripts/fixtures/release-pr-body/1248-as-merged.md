:robot: I have created a release *beep* *boop*
---


<details><summary>npm-cloud: 0.37.0</summary>

## [0.37.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.36.0...npm-cloud-v0.37.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* **cli:** `cld plugins install` refuses package plugins in the old `cld.apiVersion`/`cld.entry` format, and already installed old-format directories are listed as `incompatible` and no longer load. Authors re-pack with `bun run node_modules/@k2b/cloud/scripts/cli-pack.ts <module.ts> --references <dir> --out <dir>` and republish. Users reinstall with `cld plugins install <source>` and remove old directories with `cld plugins remove <id>`. `cld mail reference …` is now `cld mail reference-number …` with unchanged flags and output.

### Features

* **ai:** show a visible reason when the Assistant stops without an answer after a failed step ([#1256](https://github.com/k2b-dev/cloud/issues/1256)) ([d6b8764](https://github.com/k2b-dev/cloud/commit/d6b87643e1fde4bc210db0900f5e06b2911351f2)), closes [#1150](https://github.com/k2b-dev/cloud/issues/1150)
* **chat:** start chats and manage members from the full view ([#1252](https://github.com/k2b-dev/cloud/issues/1252)) ([dc04b5c](https://github.com/k2b-dev/cloud/commit/dc04b5ce4c929d7db1b4ec1c809431c46c9ae13d))
* **cli:** package plugins ship skill references in the same verified bundle as served plugins ([#1227](https://github.com/k2b-dev/cloud/issues/1227)) ([f951e96](https://github.com/k2b-dev/cloud/commit/f951e967437834941fe48b9a91803b63265e9a1c))
* **cloud:** hide the app bar and app navigation with Cmd/Ctrl+\ and bring them back from the left edge ([#1272](https://github.com/k2b-dev/cloud/issues/1272)) ([5994db9](https://github.com/k2b-dev/cloud/commit/5994db9f1e5568641e8be43d5c5c678571e80a92))
* **cloud:** show the app as a rounded card from 1024 px with a 56 px rail on every tablet and desktop width ([#1261](https://github.com/k2b-dev/cloud/issues/1261)) ([52e392e](https://github.com/k2b-dev/cloud/commit/52e392e2ba945c3fe47e8d05377f1c16c19b7d7f))
* **notebooks:** send snapshot uploads only to public storage unless the operator allows internal targets ([#1243](https://github.com/k2b-dev/cloud/issues/1243)) ([c7336a3](https://github.com/k2b-dev/cloud/commit/c7336a37c613d6852a5979615f75ec1e282680ad))
* **ssr:** content-hashed island asset URLs and modulepreload for the page's island modules ([#1219](https://github.com/k2b-dev/cloud/issues/1219)) ([a254388](https://github.com/k2b-dev/cloud/commit/a254388aad6301f3d8afe57e41cd1e0a33fcdc9f))


### Bug Fixes

* **ai:** open Cloud resource links in Assistant answers even when the model drops the leading slash ([#1262](https://github.com/k2b-dev/cloud/issues/1262)) ([5de9eb6](https://github.com/k2b-dev/cloud/commit/5de9eb6c5f80cd340b4159505624dfe451cab15a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ssr bumped from 0.16.0 to 0.17.0
    * @k2b/ui bumped from 0.26.0 to 0.27.0
</details>

<details><summary>cloud: 0.44.0</summary>

## [0.44.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.43.0...cloud-v0.44.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* **cli:** `cld plugins install` refuses package plugins in the old `cld.apiVersion`/`cld.entry` format, and already installed old-format directories are listed as `incompatible` and no longer load. Authors re-pack with `bun run node_modules/@k2b/cloud/scripts/cli-pack.ts <module.ts> --references <dir> --out <dir>` and republish. Users reinstall with `cld plugins install <source>` and remove old directories with `cld plugins remove <id>`. `cld mail reference …` is now `cld mail reference-number …` with unchanged flags and output.

### Features

* **ai:** show a visible reason when the Assistant stops without an answer after a failed step ([#1256](https://github.com/k2b-dev/cloud/issues/1256)) ([d6b8764](https://github.com/k2b-dev/cloud/commit/d6b87643e1fde4bc210db0900f5e06b2911351f2)), closes [#1150](https://github.com/k2b-dev/cloud/issues/1150)
* **chat:** start chats and manage members from the full view ([#1252](https://github.com/k2b-dev/cloud/issues/1252)) ([dc04b5c](https://github.com/k2b-dev/cloud/commit/dc04b5ce4c929d7db1b4ec1c809431c46c9ae13d))
* **cli:** package plugins ship skill references in the same verified bundle as served plugins ([#1227](https://github.com/k2b-dev/cloud/issues/1227)) ([f951e96](https://github.com/k2b-dev/cloud/commit/f951e967437834941fe48b9a91803b63265e9a1c))
* **cloud:** hide the app bar and app navigation with Cmd/Ctrl+\ and bring them back from the left edge ([#1272](https://github.com/k2b-dev/cloud/issues/1272)) ([5994db9](https://github.com/k2b-dev/cloud/commit/5994db9f1e5568641e8be43d5c5c678571e80a92))
* **cloud:** show the app as a rounded card from 1024 px with a 56 px rail on every tablet and desktop width ([#1261](https://github.com/k2b-dev/cloud/issues/1261)) ([52e392e](https://github.com/k2b-dev/cloud/commit/52e392e2ba945c3fe47e8d05377f1c16c19b7d7f))
* **notebooks:** send snapshot uploads only to public storage unless the operator allows internal targets ([#1243](https://github.com/k2b-dev/cloud/issues/1243)) ([c7336a3](https://github.com/k2b-dev/cloud/commit/c7336a37c613d6852a5979615f75ec1e282680ad))
* **ssr:** content-hashed island asset URLs and modulepreload for the page's island modules ([#1219](https://github.com/k2b-dev/cloud/issues/1219)) ([a254388](https://github.com/k2b-dev/cloud/commit/a254388aad6301f3d8afe57e41cd1e0a33fcdc9f))
* **ui:** group the slash menu into fixed sections with forgiving German and English search ([#1276](https://github.com/k2b-dev/cloud/issues/1276)) ([42f7894](https://github.com/k2b-dev/cloud/commit/42f7894bdb47d37e51d2769185bb0831baacd841))
* **ui:** keep the slash list steady, find commands by German words, and say why one is unavailable ([#1264](https://github.com/k2b-dev/cloud/issues/1264)) ([907e798](https://github.com/k2b-dev/cloud/commit/907e79811fe337e011cee5f61dbf14f93592af78))
* **ui:** show bottom sheets as a centered dialog on tablets, starting with Cloud Login approvals ([#1270](https://github.com/k2b-dev/cloud/issues/1270)) ([af93a95](https://github.com/k2b-dev/cloud/commit/af93a95d5b9f5f48104ada493ba2095e59ccc4a6))
* **ui:** workspace columns that collapse by width, with a fixed back step and resizable widths ([#1249](https://github.com/k2b-dev/cloud/issues/1249)) ([144f2ab](https://github.com/k2b-dev/cloud/commit/144f2abc0afc8e2af014f60fa8a173226dffe238))


### Bug Fixes

* **ai:** open Cloud resource links in Assistant answers even when the model drops the leading slash ([#1262](https://github.com/k2b-dev/cloud/issues/1262)) ([5de9eb6](https://github.com/k2b-dev/cloud/commit/5de9eb6c5f80cd340b4159505624dfe451cab15a))
* **filesv2:** end upload requests that never answer instead of freezing the batch ([#1257](https://github.com/k2b-dev/cloud/issues/1257)) ([3564daf](https://github.com/k2b-dev/cloud/commit/3564daf69d1cb7b1bb075dd5f5fd2a5a78d1e1a3))
* **filesv2:** keep upload progress after temporary errors and stop retry dead ends ([#1271](https://github.com/k2b-dev/cloud/issues/1271)) ([be07efb](https://github.com/k2b-dev/cloud/commit/be07efbdb297216d8859c1b48ec1b696c929b007))
* **mail:** let an automation's status step apply while older mail of the thread still loads ([#1267](https://github.com/k2b-dev/cloud/issues/1267)) ([2084d42](https://github.com/k2b-dev/cloud/commit/2084d4268e3d1d03ff3e48404a4b1bcc301a30b8))
* **mail:** let queued user commands get the provider lease between folder syncs ([#1268](https://github.com/k2b-dev/cloud/issues/1268)) ([#1273](https://github.com/k2b-dev/cloud/issues/1273)) ([54b1e5e](https://github.com/k2b-dev/cloud/commit/54b1e5e56b7a86c62d719658a49951d484537b8b))
* **mail:** run two incoming automations on the same message without failing each other ([#1250](https://github.com/k2b-dev/cloud/issues/1250)) ([67fea2c](https://github.com/k2b-dev/cloud/commit/67fea2c7a96479b0e01abec78c62bdda2bd5026e)), closes [#1036](https://github.com/k2b-dev/cloud/issues/1036)
* **mail:** show HTML mail adapted to dark mode and never show an empty text part ([#1253](https://github.com/k2b-dev/cloud/issues/1253)) ([fd4c51e](https://github.com/k2b-dev/cloud/commit/fd4c51eb6b8ded8fdcd1b194904bb88725592358))
* **notebooks:** one workspace surface in the graph view, no back button on attachments, labeled sidebar footer items ([#1279](https://github.com/k2b-dev/cloud/issues/1279)) ([a931a47](https://github.com/k2b-dev/cloud/commit/a931a470f1f6df406bb82f92aeb6d53473fa7e32))
* **ui:** keep focus on a day view run of empty days while days load into it ([#1245](https://github.com/k2b-dev/cloud/issues/1245)) ([df01d61](https://github.com/k2b-dev/cloud/commit/df01d61995e59bbd6d3a253b033c3368d5b86e9c))
</details>

<details><summary>npm-ssr: 0.17.0</summary>

## [0.17.0](https://github.com/k2b-dev/cloud/compare/npm-ssr-v0.16.0...npm-ssr-v0.17.0) (2026-10-16)


### Features

* **ssr:** content-hashed island asset URLs and modulepreload for the page's island modules ([#1219](https://github.com/k2b-dev/cloud/issues/1219)) ([a254388](https://github.com/k2b-dev/cloud/commit/a254388aad6301f3d8afe57e41cd1e0a33fcdc9f))
</details>

<details><summary>npm-ui: 0.27.0</summary>

## [0.27.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.26.0...npm-ui-v0.27.0) (2026-10-16)


### Features

* **chat:** start chats and manage members from the full view ([#1252](https://github.com/k2b-dev/cloud/issues/1252)) ([dc04b5c](https://github.com/k2b-dev/cloud/commit/dc04b5ce4c929d7db1b4ec1c809431c46c9ae13d))
* **cloud:** show the app as a rounded card from 1024 px with a 56 px rail on every tablet and desktop width ([#1261](https://github.com/k2b-dev/cloud/issues/1261)) ([52e392e](https://github.com/k2b-dev/cloud/commit/52e392e2ba945c3fe47e8d05377f1c16c19b7d7f))
* **ssr:** content-hashed island asset URLs and modulepreload for the page's island modules ([#1219](https://github.com/k2b-dev/cloud/issues/1219)) ([a254388](https://github.com/k2b-dev/cloud/commit/a254388aad6301f3d8afe57e41cd1e0a33fcdc9f))
* **ui:** group the slash menu into fixed sections with forgiving German and English search ([#1276](https://github.com/k2b-dev/cloud/issues/1276)) ([42f7894](https://github.com/k2b-dev/cloud/commit/42f7894bdb47d37e51d2769185bb0831baacd841))
* **ui:** keep the slash list steady, find commands by German words, and say why one is unavailable ([#1264](https://github.com/k2b-dev/cloud/issues/1264)) ([907e798](https://github.com/k2b-dev/cloud/commit/907e79811fe337e011cee5f61dbf14f93592af78))
* **ui:** show bottom sheets as a centered dialog on tablets, starting with Cloud Login approvals ([#1270](https://github.com/k2b-dev/cloud/issues/1270)) ([af93a95](https://github.com/k2b-dev/cloud/commit/af93a95d5b9f5f48104ada493ba2095e59ccc4a6))
* **ui:** workspace columns that collapse by width, with a fixed back step and resizable widths ([#1249](https://github.com/k2b-dev/cloud/issues/1249)) ([144f2ab](https://github.com/k2b-dev/cloud/commit/144f2abc0afc8e2af014f60fa8a173226dffe238))


### Bug Fixes

* **ui:** keep focus on a day view run of empty days while days load into it ([#1245](https://github.com/k2b-dev/cloud/issues/1245)) ([df01d61](https://github.com/k2b-dev/cloud/commit/df01d61995e59bbd6d3a253b033c3368d5b86e9c))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @k2b/ssr bumped from 0.16.0 to 0.17.0
  * peerDependencies
    * @k2b/ssr bumped from ^0.12.0 || ^0.13.0 || ^0.14.0 || ^0.15.0 || ^0.16.0 || ^0.17.0 to ^0.17.0
</details>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).


