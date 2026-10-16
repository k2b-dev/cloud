# Changelog

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

## [0.36.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.35.0...npm-cloud-v0.36.0) (2026-10-16)


### Features

* **pulse:** scrape only public metrics endpoints unless the operator allows internal targets ([#1218](https://github.com/k2b-dev/cloud/issues/1218)) ([9bdeaaf](https://github.com/k2b-dev/cloud/commit/9bdeaaf281855a8237617b9900c4f01cc22846e8))


### Bug Fixes

* **spaces:** keep the space settings open when a person is added ([#1222](https://github.com/k2b-dev/cloud/issues/1222)) ([3de096b](https://github.com/k2b-dev/cloud/commit/3de096badaa71c54d0f7ca5ef3acf6668f2c003c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.25.0 to 0.26.0

## [0.35.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.34.0...npm-cloud-v0.35.0) (2026-10-15)


### Features

* **cloud:** keep the webhook tester and other person-chosen requests away from internal addresses ([#1192](https://github.com/k2b-dev/cloud/issues/1192)) ([7efd4e7](https://github.com/k2b-dev/cloud/commit/7efd4e7e64d8e66cb9322bc0a0cadaebab36afc1))


### Bug Fixes

* **ai:** describe capability inputs to every model provider in a shape it accepts (Closes [#1149](https://github.com/k2b-dev/cloud/issues/1149)) ([#1203](https://github.com/k2b-dev/cloud/issues/1203)) ([7cdd720](https://github.com/k2b-dev/cloud/commit/7cdd720962eaf43388bcaca1bed88500330479c7))

## [0.34.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.33.0...npm-cloud-v0.34.0) (2026-10-15)


### Features

* **cli:** print a permalink for every resource in cld JSON output ([#1153](https://github.com/k2b-dev/cloud/issues/1153)) ([f3f60e3](https://github.com/k2b-dev/cloud/commit/f3f60e35d0f9f72f8f6d5ed1950ab0776ec3ffa4))
* **cloud:** let widgets declare a few settings and get them per board entry ([#1094](https://github.com/k2b-dev/cloud/issues/1094)) ([e9273f1](https://github.com/k2b-dev/cloud/commit/e9273f16988e457e9959e33c94dfa55fcca2c520))
* **cloud:** switch appearance with one button that cycles Automatic, Light, Dark ([#1131](https://github.com/k2b-dev/cloud/issues/1131)) ([aefeb09](https://github.com/k2b-dev/cloud/commit/aefeb0955897b6f5b85515aa51e5e538e260bd87))
* **core:** pair the phone app by scanning a QR code on every device ([#1127](https://github.com/k2b-dev/cloud/issues/1127)) ([eb44239](https://github.com/k2b-dev/cloud/commit/eb442393cdfaa52a64f0e5aaeffe1f2d5c7a63a8)), closes [#1102](https://github.com/k2b-dev/cloud/issues/1102)
* **dashboard:** adjust a widget's settings on the board, place a widget with settings more than once, and move widgets without dragging ([#1133](https://github.com/k2b-dev/cloud/issues/1133)) ([d756c22](https://github.com/k2b-dev/cloud/commit/d756c223b5981a9247c3e5bea8831423f0aaf0e0))
* **ssr:** mount island props without eval so pages run under a CSP without unsafe-eval ([#1106](https://github.com/k2b-dev/cloud/issues/1106)) ([06b0b42](https://github.com/k2b-dev/cloud/commit/06b0b4280a1dfa858ee4ee4be5b6922106659d72)), closes [#1080](https://github.com/k2b-dev/cloud/issues/1080)
* **ui:** add key caps, label chips, a table of contents, and callout icons ([#1134](https://github.com/k2b-dev/cloud/issues/1134)) ([ae8c68c](https://github.com/k2b-dev/cloud/commit/ae8c68c546bc188add1df26f15c4b1e553a8f777))


### Bug Fixes

* **cloud:** an approval no longer runs after its device was removed or the person signed out everywhere ([#1136](https://github.com/k2b-dev/cloud/issues/1136)) ([d1ac47c](https://github.com/k2b-dev/cloud/commit/d1ac47c8eadad60347ac7b24378c30536c19199f))
* **cloud:** keep Help in its app and stop the search jump ([#1109](https://github.com/k2b-dev/cloud/issues/1109)) ([771b89c](https://github.com/k2b-dev/cloud/commit/771b89cc7cd44405e2b826400f4ed16e2231bc51))
* **ui:** keep hover and focus from moving or lifting elements ([#1162](https://github.com/k2b-dev/cloud/issues/1162)) ([2778d49](https://github.com/k2b-dev/cloud/commit/2778d4931a85d408a549b53479ffd073254c0f42))
* **ui:** keep the rounded app card on wide screens for flat workspaces too ([#1135](https://github.com/k2b-dev/cloud/issues/1135)) ([480faf5](https://github.com/k2b-dev/cloud/commit/480faf515983a00cd44e84c8a03f336881756124)), closes [#1088](https://github.com/k2b-dev/cloud/issues/1088)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ssr bumped from 0.15.1 to 0.16.0
    * @k2b/ui bumped from 0.24.0 to 0.25.0

## [0.33.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.32.0...npm-cloud-v0.33.0) (2026-10-13)


### Features

* **cloud:** follow the system light or dark appearance automatically ([#1048](https://github.com/k2b-dev/cloud/issues/1048)) ([fa6a391](https://github.com/k2b-dev/cloud/commit/fa6a391d1a6e02c090f4ee811d0e00651f2fd1f1))
* **mail:** let one automation mark mail read and move it, and exclude senders or text ([#1042](https://github.com/k2b-dev/cloud/issues/1042)) ([e6a3ded](https://github.com/k2b-dev/cloud/commit/e6a3dede32a6a702be6c8fb2da0de3b4de545a8f))
* **ui:** let the app area reach the window edge in the installed iPad app ([#1067](https://github.com/k2b-dev/cloud/issues/1067)) ([5d6493e](https://github.com/k2b-dev/cloud/commit/5d6493eb92a39fed8e6349e0587c0ce073bc7d71)), closes [#1049](https://github.com/k2b-dev/cloud/issues/1049)
* **ui:** one sidebar switcher for the current notebook, space, mailbox or base in every app ([#1059](https://github.com/k2b-dev/cloud/issues/1059)) ([9783993](https://github.com/k2b-dev/cloud/commit/9783993ffd04b327fc242c38a009a49a874a05e1)), closes [#1047](https://github.com/k2b-dev/cloud/issues/1047)


### Bug Fixes

* **ai:** find relevant memories for long messages too ([#1068](https://github.com/k2b-dev/cloud/issues/1068)) ([4a654ad](https://github.com/k2b-dev/cloud/commit/4a654ad605d74ce018a9b85bbe7ca11b0795abb3))
* **ai:** learn only about the person, skip sensitive data, keep project knowledge in projects, and use memories only when they matter ([#1062](https://github.com/k2b-dev/cloud/issues/1062)) ([e739ca3](https://github.com/k2b-dev/cloud/commit/e739ca38fec1a8f9dac44303b26eca2abd003357))
* **assistant:** build requested apps as Studio apps, quickly, instead of visualizations ([#1074](https://github.com/k2b-dev/cloud/issues/1074)) ([25409be](https://github.com/k2b-dev/cloud/commit/25409bef7810c7bea419c98fdf3f57ca0c6ad006)), closes [#1051](https://github.com/k2b-dev/cloud/issues/1051)
* **cloud:** keep outbox claims bounded when the outbox statistics are from an empty table ([#1070](https://github.com/k2b-dev/cloud/issues/1070)) ([2bc7772](https://github.com/k2b-dev/cloud/commit/2bc77727718a1b7e3c993e3a4f8c416cf4007ce6)), closes [#1046](https://github.com/k2b-dev/cloud/issues/1046)
* **ui:** sidebar switcher keeps app colors on phones, never covers or jumps around its trigger, and keeps one head height ([#1075](https://github.com/k2b-dev/cloud/issues/1075)) ([6eaef4b](https://github.com/k2b-dev/cloud/commit/6eaef4b7d46d1f94a38934eecd7b69011c7b2ad0))


### Performance Improvements

* **cloud:** render the app shell with at most four islands ([#1033](https://github.com/k2b-dev/cloud/issues/1033)) ([759266b](https://github.com/k2b-dev/cloud/commit/759266bc70bf702871832013dc3cfdaf98afff94))
* **cloud:** stop loading dayjs and big.js on pages that do not use them ([#1065](https://github.com/k2b-dev/cloud/issues/1065)) ([84fcc0b](https://github.com/k2b-dev/cloud/commit/84fcc0bb258aeb22f0e9152800c8c7411d82e65e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ssr bumped from 0.15.0 to 0.15.1
    * @k2b/ui bumped from 0.23.0 to 0.24.0

## [0.32.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.31.0...npm-cloud-v0.32.0) (2026-10-12)


### Features

* **ai:** chart groups with a shared cursor, more chart kinds and one render path ([#965](https://github.com/k2b-dev/cloud/issues/965)) ([98fd68a](https://github.com/k2b-dev/cloud/commit/98fd68af0d2a6c09a7bff6c6b858f27c493091a3))
* **ai:** explore a computed dataset in the chat with views, filters and comparison ([#986](https://github.com/k2b-dev/cloud/issues/986)) ([cf55b85](https://github.com/k2b-dev/cloud/commit/cf55b850f6a15d1c1f71cecf247dfac83aa54c3d))
* **ai:** serve Assistant models through an OpenAI-compatible endpoint with models-only keys ([#969](https://github.com/k2b-dev/cloud/issues/969)) ([fff481b](https://github.com/k2b-dev/cloud/commit/fff481bd88056531c9125745c25b867dcfd25c81))
* **ai:** show charts and tables computed in code runs without retyping their values ([#949](https://github.com/k2b-dev/cloud/issues/949)) ([49399e0](https://github.com/k2b-dev/cloud/commit/49399e0a7f3d9f4e0880697e60794bfa1f30e52f))
* **ai:** show key figures, record details and linked Cloud objects from code runs ([#972](https://github.com/k2b-dev/cloud/issues/972)) ([0898cc3](https://github.com/k2b-dev/cloud/commit/0898cc380ba2f7b77eee23286113a18bac56fbaa))
* **ai:** show the time on approval receipts, live and in history ([#959](https://github.com/k2b-dev/cloud/issues/959)) ([d585ebc](https://github.com/k2b-dev/cloud/commit/d585ebcdab91e4afd5e54f52f1553ee1acf21ce1)), closes [#810](https://github.com/k2b-dev/cloud/issues/810)
* **assistant:** keep Cloud skills compatible with Agent Skills ([#987](https://github.com/k2b-dev/cloud/issues/987)) ([a04da4b](https://github.com/k2b-dev/cloud/commit/a04da4b5343293851928c4535f124aab77de2580))
* **assistant:** let cld work with local files and folders ([#971](https://github.com/k2b-dev/cloud/issues/971)) ([0926d75](https://github.com/k2b-dev/cloud/commit/0926d756f3b7e042e4d32e98c6558976b19de240))
* **assistant:** run the Cloud Assistant in editors through ACP ([#980](https://github.com/k2b-dev/cloud/issues/980)) ([df00d89](https://github.com/k2b-dev/cloud/commit/df00d89d550913e072d7c019227aac23aef4b1ba))
* **chat:** deliver live updates and recover after reconnects and gaps ([#1029](https://github.com/k2b-dev/cloud/issues/1029)) ([953aad1](https://github.com/k2b-dev/cloud/commit/953aad1bb7368f9acd6f2123e2b5d918a3923c38))
* **cloud-login:** approve Cloud actions from the Cloud Login app ([#973](https://github.com/k2b-dev/cloud/issues/973)) ([73eab63](https://github.com/k2b-dev/cloud/commit/73eab63fa6bafe4a840ed28adcf071f778d7c6ae))
* **cloud:** approve pending actions inside Cloud, in the owning app and in the Assistant ([#963](https://github.com/k2b-dev/cloud/issues/963)) ([cf15171](https://github.com/k2b-dev/cloud/commit/cf151710d46bceb04f21059f46179f63f1831c6f))
* **cloud:** keep Zod out of the mailbox first load and add a validator-free isCommandPath ([#1009](https://github.com/k2b-dev/cloud/issues/1009)) ([0843aec](https://github.com/k2b-dev/cloud/commit/0843aec9ec819891661e25d6d58d2d286757790e))
* **mail:** keep quotes and code blocks in sent Markdown mail ([#1022](https://github.com/k2b-dev/cloud/issues/1022)) ([ac68216](https://github.com/k2b-dev/cloud/commit/ac6821637c67bfbb6617c685cc2232d08d90a0b5))
* **ui:** give the detail panel the full height and drop page titles the sidebar already shows ([#1003](https://github.com/k2b-dev/cloud/issues/1003)) ([081daf9](https://github.com/k2b-dev/cloud/commit/081daf9c4497590c181648ac5d3f13de7cde5038))


### Bug Fixes

* **ai:** let the model repair a malformed tool call instead of ending the turn silently ([#968](https://github.com/k2b-dev/cloud/issues/968)) ([6e28096](https://github.com/k2b-dev/cloud/commit/6e28096c5985aca6f0319e45f906f8cac0c6d834)), closes [#833](https://github.com/k2b-dev/cloud/issues/833)
* **ai:** stop chat compaction when the model provider stalls ([#993](https://github.com/k2b-dev/cloud/issues/993)) ([7b938cd](https://github.com/k2b-dev/cloud/commit/7b938cdfe0c7bb51e58c62dbee599d6f6afbc368)), closes [#960](https://github.com/k2b-dev/cloud/issues/960) [#961](https://github.com/k2b-dev/cloud/issues/961)
* **cloud:** mark required flags in cld help and document Mail template variables ([#951](https://github.com/k2b-dev/cloud/issues/951)) ([c69438b](https://github.com/k2b-dev/cloud/commit/c69438b9c9df8e3e29849689bfb9afa7f4a1b11f))
* **cloud:** update the MCP SDK past its OAuth credential advisory ([#988](https://github.com/k2b-dev/cloud/issues/988)) ([c019fc5](https://github.com/k2b-dev/cloud/commit/c019fc50835773159c23ff7e59d1dc44344a3401))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.22.0 to 0.23.0

## [0.31.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.30.0...npm-cloud-v0.31.0) (2026-10-11)


### Features

* **ai:** ask once per website and per chat instead of for every request ([#861](https://github.com/k2b-dev/cloud/issues/861)) ([52fe800](https://github.com/k2b-dev/cloud/commit/52fe8003e1109c69b8f5e1c863da17145ae844a6))
* **ai:** write Studio source as top-level text so providers cannot cut files to their first line ([#940](https://github.com/k2b-dev/cloud/issues/940)) ([9557a82](https://github.com/k2b-dev/cloud/commit/9557a8244f2d5817f00f0418e6659f0f5fda3be9)), closes [#884](https://github.com/k2b-dev/cloud/issues/884)
* **assistant:** make cld assistant a comfortable line-based agent with permissions and more slash commands ([#938](https://github.com/k2b-dev/cloud/issues/938)) ([29b475d](https://github.com/k2b-dev/cloud/commit/29b475d6fbdcd1646cac063d634f24a24fb48a1b))
* **cli:** let plugins declare short module aliases and command shortcuts ([#947](https://github.com/k2b-dev/cloud/issues/947)) ([75b2ce2](https://github.com/k2b-dev/cloud/commit/75b2ce2bf9621efca926b269a95a3b1bad957e11))
* **cloud:** record every pending approval as one platform request with scope, binding and expiry ([#943](https://github.com/k2b-dev/cloud/issues/943)) ([e5d874c](https://github.com/k2b-dev/cloud/commit/e5d874c003144fd02116bbf2908f919e10915843))
* **cloud:** use the whole window on tablets and laptops, and show the way up to the pages above ([#908](https://github.com/k2b-dev/cloud/issues/908)) ([677cf5d](https://github.com/k2b-dev/cloud/commit/677cf5dbde0dd7f66f2f91a7826f3aad9ae6ea52))
* **dashboard:** one board of widgets in three sizes that people can arrange themselves ([#885](https://github.com/k2b-dev/cloud/issues/885)) ([0ff5872](https://github.com/k2b-dev/cloud/commit/0ff5872d5f558b41b27dfa43b50e7d3da6f4b67e))
* **mail:** keep phone links, let mailbox CSS win, and report what email removes from a message ([#946](https://github.com/k2b-dev/cloud/issues/946)) ([82132c0](https://github.com/k2b-dev/cloud/commit/82132c09bd1c95335973ac393a1de6f86ba78c25))
* **notebooks:** one sidebar instead of the Navigator and simple modes ([#916](https://github.com/k2b-dev/cloud/issues/916)) ([42df3f6](https://github.com/k2b-dev/cloud/commit/42df3f610df8daad48a0edaaec9984a6e7aa7cc0))
* **ui:** float the workspace detail panel instead of docking it ([#934](https://github.com/k2b-dev/cloud/issues/934)) ([cf25e0b](https://github.com/k2b-dev/cloud/commit/cf25e0b06f009dda6a8c51321bdfd7ce31e9147f))
* **ui:** keep drags from selecting page text on iPad ([#902](https://github.com/k2b-dev/cloud/issues/902)) ([d65a827](https://github.com/k2b-dev/cloud/commit/d65a827d24a8a7fa10589d07be52e8dc561a1ea4))


### Bug Fixes

* **ai:** align the expanded work flush left and fold repeated steps into one row ([#928](https://github.com/k2b-dev/cloud/issues/928)) ([ffa193b](https://github.com/k2b-dev/cloud/commit/ffa193be5202be3ae74908df3aa3897f701f929a))
* **ai:** show the status text of a running turn quietly so it does not look like the answer ([#933](https://github.com/k2b-dev/cloud/issues/933)) ([b0832f1](https://github.com/k2b-dev/cloud/commit/b0832f1c74ce8c8379167742ba86dc3dd25c5a77))
* **cloud:** keep Cloud pages within the window when vh is taller ([#880](https://github.com/k2b-dev/cloud/issues/880)) ([5fbe2dc](https://github.com/k2b-dev/cloud/commit/5fbe2dc414c38c48ea7ee7808b03fadf2199b036))
* **cloud:** keep pop-out windows and public displays within the window when vh is taller ([#948](https://github.com/k2b-dev/cloud/issues/948)) ([8670aa2](https://github.com/k2b-dev/cloud/commit/8670aa252abc81f67b8fe64720722d12637b0266)), closes [#881](https://github.com/k2b-dev/cloud/issues/881)
* **cloud:** only follow the way up to a URL on this origin ([#927](https://github.com/k2b-dev/cloud/issues/927)) ([8777efa](https://github.com/k2b-dev/cloud/commit/8777efa72de194e6958d16a514449280c43d4f59))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.21.0 to 0.22.0

## [0.30.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.29.1...npm-cloud-v0.30.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* **mail:** let conversations have several assignees and grant access to assigned conversations only ([#830](https://github.com/k2b-dev/cloud/issues/830))

### Features

* **ai:** show charts directly in the chat without building an app ([#847](https://github.com/k2b-dev/cloud/issues/847)) ([18a129d](https://github.com/k2b-dev/cloud/commit/18a129dcb05d9ed4043a7a416b2c6cca727997c6))
* **capabilities:** let apps word their own approval and receipt sentences ([#846](https://github.com/k2b-dev/cloud/issues/846)) ([cc5a4d6](https://github.com/k2b-dev/cloud/commit/cc5a4d69d03f42f10ebd67b3b91ab0bd83c7386b)), closes [#811](https://github.com/k2b-dev/cloud/issues/811)
* **cloud:** let apps ship their own Assistant skills ([#840](https://github.com/k2b-dev/cloud/issues/840)) ([d0b1ac6](https://github.com/k2b-dev/cloud/commit/d0b1ac6db6d3199b072684704f84dc0a74d6a506))
* **cloud:** show Help only to people who may open the app ([#827](https://github.com/k2b-dev/cloud/issues/827)) ([cce4f28](https://github.com/k2b-dev/cloud/commit/cce4f280fc39e5b90647bccebef4ac2dbbde90dd))
* **dashboard:** stream widgets in as they load instead of failing the whole board ([#831](https://github.com/k2b-dev/cloud/issues/831)) ([e7ff2ce](https://github.com/k2b-dev/cloud/commit/e7ff2ce2c13a4a6e2e49fc4c2ef7b9a236ca78b9))
* **mail:** let conversations have several assignees and grant access to assigned conversations only ([#830](https://github.com/k2b-dev/cloud/issues/830)) ([631c73a](https://github.com/k2b-dev/cloud/commit/631c73a05bf8eafe74b0af61920237657678193a))


### Bug Fixes

* **ai:** keep code runs from failing while they wait for an approval ([#832](https://github.com/k2b-dev/cloud/issues/832)) ([cbdaa0f](https://github.com/k2b-dev/cloud/commit/cbdaa0fee308e890fd940b242d8d2ce6c78bc2f2))


### Performance Improvements

* keep Zod, KaTeX, Liquid and on-demand dialogs out of the shell and Mail first load ([#851](https://github.com/k2b-dev/cloud/issues/851)) ([90d919a](https://github.com/k2b-dev/cloud/commit/90d919ac1ab8ca65c8b99d0e7617824c73ce9e69))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.20.0 to 0.21.0

## [0.29.1](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.29.0...npm-cloud-v0.29.1) (2026-10-09)


### Bug Fixes

* **cloud:** document the Postgres outbox and public HTTPS fetch, and end an outbox batch with its claim ([#787](https://github.com/k2b-dev/cloud/issues/787)) ([d613448](https://github.com/k2b-dev/cloud/commit/d6134480ce7f2ce3f3fe1cd488a30896d76f3899))
* **scripts:** run one heavy check or test run per machine with bounded type checkers ([#791](https://github.com/k2b-dev/cloud/issues/791)) ([bbc4932](https://github.com/k2b-dev/cloud/commit/bbc493290e9088dbbf2c3f14b4ea141a6609eca5))
* **ui:** keep short table columns readable next to long ones ([#785](https://github.com/k2b-dev/cloud/issues/785)) ([4f12a78](https://github.com/k2b-dev/cloud/commit/4f12a7807795dc66e68e38d834bb7be4e8ed2967))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.19.0 to 0.20.0

## [0.29.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.28.0...npm-cloud-v0.29.0) (2026-10-09)


### Features

* **access:** let the permission editor count managers as the service does ([#775](https://github.com/k2b-dev/cloud/issues/775)) ([f82f707](https://github.com/k2b-dev/cloud/commit/f82f7077c7d3d4681aa4ee2b3641dcd59b459b09))
* **ai:** notice when an offer fits and tell the Assistant, so weaker models make it too ([#780](https://github.com/k2b-dev/cloud/issues/780)) ([ec3d0e3](https://github.com/k2b-dev/cloud/commit/ec3d0e379607af21c306e26015c96087465e2c9f))
* **ai:** show the Studio check calmly in the chat ([#766](https://github.com/k2b-dev/cloud/issues/766)) ([f3c6342](https://github.com/k2b-dev/cloud/commit/f3c63426d16e2ffe512f4b08b4ac9463ca53e03f))
* **ai:** update nessi to 0.17 for clean failed turns and provider-stopped answers ([#741](https://github.com/k2b-dev/cloud/issues/741)) ([2ba86f9](https://github.com/k2b-dev/cloud/commit/2ba86f9533b43a330fe15a4f2821fb44f885f5fb))
* **assistant:** catch misaligned layouts and check the whole page before a Studio app is shown ([#758](https://github.com/k2b-dev/cloud/issues/758)) ([1598f02](https://github.com/k2b-dev/cloud/commit/1598f02a789cc401e3d74409226d573155e8aeaa))
* attach files from Cloud apps in Spaces, Grids, Notebooks and Assistant ([#749](https://github.com/k2b-dev/cloud/issues/749)) ([435d7ae](https://github.com/k2b-dev/cloud/commit/435d7aedea05cf4ab42d7911e2b2fc57c2f84815))
* **chat:** add the chat app behind an unreleased Compose profile ([#750](https://github.com/k2b-dev/cloud/issues/750)) ([5e71315](https://github.com/k2b-dev/cloud/commit/5e71315799a0dd0fa2fa4498177d626737f24132))
* **cloud:** bound Liquid render time and output size separately ([#759](https://github.com/k2b-dev/cloud/issues/759)) ([ce861a7](https://github.com/k2b-dev/cloud/commit/ce861a7bb8377035320b11061cd8f178c119fa30))
* **cloud:** keep bearer tokens in URLs out of logs and gateway telemetry ([#747](https://github.com/k2b-dev/cloud/issues/747)) ([817b341](https://github.com/k2b-dev/cloud/commit/817b34198c489a83f27fe338dfbd66842d73f50f))
* **cloud:** remove location data from photos embedded in notes and comments ([#757](https://github.com/k2b-dev/cloud/issues/757)) ([deb0f00](https://github.com/k2b-dev/cloud/commit/deb0f00cfd5b35afd3258c02d483b2749896ceae))
* **cloud:** show a calm error state instead of a frozen app view ([#740](https://github.com/k2b-dev/cloud/issues/740)) ([1fd7220](https://github.com/k2b-dev/cloud/commit/1fd7220f21382424ded073a5e843a02949a25930))
* **layout:** show app badges in the rail and app grid ([#769](https://github.com/k2b-dev/cloud/issues/769)) ([9f9587b](https://github.com/k2b-dev/cloud/commit/9f9587b9ff5de6207ba5c485d48fbea45875face))
* **notifications:** add do not disturb and quiet hours for every app ([#779](https://github.com/k2b-dev/cloud/issues/779)) ([ddce3b0](https://github.com/k2b-dev/cloud/commit/ddce3b07c7067cf8306a4436cf417bf8c94b5b9b))
* **notifications:** allow message previews in push payloads ([#762](https://github.com/k2b-dev/cloud/issues/762)) ([8f086b7](https://github.com/k2b-dev/cloud/commit/8f086b7b984683034d9baafcc76cc57d097ae023))
* **notifications:** group browser notifications and show an app badge ([#752](https://github.com/k2b-dev/cloud/issues/752)) ([9c4d77e](https://github.com/k2b-dev/cloud/commit/9c4d77ee0900d53eaf0fc15053c036cb8a895c09))
* save attachments into Files from Mail and other apps ([#765](https://github.com/k2b-dev/cloud/issues/765)) ([a6d9ae9](https://github.com/k2b-dev/cloud/commit/a6d9ae939a94886750904160ab904524b1e79d45))
* **spaces:** add task and event templates ([#764](https://github.com/k2b-dev/cloud/issues/764)) ([8c98ecd](https://github.com/k2b-dev/cloud/commit/8c98ecd44e17bf517554caad1c74eb9051d2b076))
* **spaces:** say which tasks are overdue in task lists ([#774](https://github.com/k2b-dev/cloud/issues/774)) ([9dcfb7e](https://github.com/k2b-dev/cloud/commit/9dcfb7e2040d1206ea634ffe4e0287811a8362b3))


### Bug Fixes

* **ai:** keep Assistant turns working when an older CLI offers retired client tools ([#760](https://github.com/k2b-dev/cloud/issues/760)) ([f9598e7](https://github.com/k2b-dev/cloud/commit/f9598e74585ef1c358bb5fb64fe426ef7283f6f9))
* **ai:** keep scheduled runs inside their grants instead of failing on a tool they may not use ([#776](https://github.com/k2b-dev/cloud/issues/776)) ([5b1f50e](https://github.com/k2b-dev/cloud/commit/5b1f50eae763bc74165dbb06812632530e1fcc28))
* **ai:** offer audio transcription only when it can run and say why when it cannot ([#748](https://github.com/k2b-dev/cloud/issues/748)) ([f63fc3f](https://github.com/k2b-dev/cloud/commit/f63fc3fcb10cd45b546437ac89a41e7f0effcba1))
* **ai:** stop learning from archived chats ([#743](https://github.com/k2b-dev/cloud/issues/743)) ([28e8ba1](https://github.com/k2b-dev/cloud/commit/28e8ba134d1a8795c9fab2a0e1cf32cca43f543b))
* **assistant:** keep CLI replies readable and chat titles as given ([#761](https://github.com/k2b-dev/cloud/issues/761)) ([c20e88c](https://github.com/k2b-dev/cloud/commit/c20e88c9e4ffe0dc9de60a3e45301a518913c58e))
* **gateway:** keep proxied requests on the app's own origin ([#777](https://github.com/k2b-dev/cloud/issues/777)) ([01ab1b4](https://github.com/k2b-dev/cloud/commit/01ab1b463db5f86e31e0571ddc5033b9e7e083e0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.18.0 to 0.19.0

## [0.28.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.27.0...npm-cloud-v0.28.0) (2026-10-08)


### ⚠ BREAKING CHANGES

* **assistant:** Studio apps are plain HTML ([#716](https://github.com/k2b-dev/cloud/issues/716))

### Features

* **ai:** calm, clear Assistant surfaces ([#719](https://github.com/k2b-dev/cloud/issues/719)) ([400da10](https://github.com/k2b-dev/cloud/commit/400da1004a259e12135050f249f565d45fe4de9b))
* **ai:** keep failed turns visible with a clear next step ([#712](https://github.com/k2b-dev/cloud/issues/712)) ([2edd0da](https://github.com/k2b-dev/cloud/commit/2edd0da4d48a98ade02a23a4604f4c81a1abdce6))
* **ai:** tell the Assistant what users see and suggest next steps ([#720](https://github.com/k2b-dev/cloud/issues/720)) ([37b8839](https://github.com/k2b-dev/cloud/commit/37b883986d85916c809a9a95d88220ff29e15f8b))
* **assistant:** check every Studio app before it is shown ([#723](https://github.com/k2b-dev/cloud/issues/723)) ([e5ec357](https://github.com/k2b-dev/cloud/commit/e5ec357b61f127b802d167be5d6df7e1024d79fb))
* **assistant:** Studio apps are plain HTML ([#716](https://github.com/k2b-dev/cloud/issues/716)) ([6863ebc](https://github.com/k2b-dev/cloud/commit/6863ebc843a82d0ac4d05fda5614adeacf842439))
* **cloud:** let apps send mail and read their send log ([#717](https://github.com/k2b-dev/cloud/issues/717)) ([3a9da9a](https://github.com/k2b-dev/cloud/commit/3a9da9af2fd242b81000f14c7734aa27b5ec9da4))
* **cloud:** mark bounced mail from delivery reports ([#734](https://github.com/k2b-dev/cloud/issues/734)) ([97fd6a7](https://github.com/k2b-dev/cloud/commit/97fd6a79f02cfeaef807f8a4e92b59f400989746))
* **cloud:** send mail in the background with pacing and retries ([#721](https://github.com/k2b-dev/cloud/issues/721)) ([05dc7d1](https://github.com/k2b-dev/cloud/commit/05dc7d117e6f5431754b1c7ce64989b4898872f6))
* **notifications:** deliver email through the default sender profile ([#725](https://github.com/k2b-dev/cloud/issues/725)) ([ab9f999](https://github.com/k2b-dev/cloud/commit/ab9f999aad1437b42ce685fe41a37bcde54ccf04))
* **ui:** calm reference pills and quiet links in every Markdown view ([#733](https://github.com/k2b-dev/cloud/issues/733)) ([4b00e92](https://github.com/k2b-dev/cloud/commit/4b00e92e52a9a54e28b4020732e96fe830d46be9))
* **ui:** drop files anywhere on the page, not into a thin strip ([#718](https://github.com/k2b-dev/cloud/issues/718)) ([732e64a](https://github.com/k2b-dev/cloud/commit/732e64a49cacf2fcd2608200a18da6815cba2a75))


### Bug Fixes

* **core:** keep Core boot migrations from failing when replicas race on a new schema ([#732](https://github.com/k2b-dev/cloud/issues/732)) ([6c07b51](https://github.com/k2b-dev/cloud/commit/6c07b516fbdb9008f63baed4588c7831943e568b))
* **spaces:** confirm saved blockers and say how many people a task really has ([#736](https://github.com/k2b-dev/cloud/issues/736)) ([c481d05](https://github.com/k2b-dev/cloud/commit/c481d05e2143629b0e46c3693c1358a57b4a564f))
* **ui:** give table lines and hover highlights one consistent width ([#722](https://github.com/k2b-dev/cloud/issues/722)) ([e9bd63e](https://github.com/k2b-dev/cloud/commit/e9bd63e84a6208cdca8e2f0b947a720823da142e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.17.0 to 0.18.0

## [0.27.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.26.0...npm-cloud-v0.27.0) (2026-10-07)


### ⚠ BREAKING CHANGES

* **assistant:** give Studio scripts and actions one cloud.* library ([#705](https://github.com/k2b-dev/cloud/issues/705))

### Features

* **ai:** end looping or long turns with an answer ([#704](https://github.com/k2b-dev/cloud/issues/704)) ([781f4e6](https://github.com/k2b-dev/cloud/commit/781f4e6d60973a6312861a3ef4e514d748e16bde))
* **ai:** offer Skills for recurring work ([#709](https://github.com/k2b-dev/cloud/issues/709)) ([d884e21](https://github.com/k2b-dev/cloud/commit/d884e211ce7265607055552c3ef203c11f751e70))
* **ai:** set the thinking level, extra headers and extra parameters per model ([#711](https://github.com/k2b-dev/cloud/issues/711)) ([28fec41](https://github.com/k2b-dev/cloud/commit/28fec411e9f75d5d299a55aa8ba2a8d9ebc614e0))
* **ai:** show chat results first in an always-available sidebar ([#699](https://github.com/k2b-dev/cloud/issues/699)) ([616e3c2](https://github.com/k2b-dev/cloud/commit/616e3c2199b1a6887fb5b235bbd6b9ad71f0aef8))
* **assistant:** give Studio scripts and actions one cloud.* library ([#705](https://github.com/k2b-dev/cloud/issues/705)) ([730d9dc](https://github.com/k2b-dev/cloud/commit/730d9dcc60471cec1856fd29a5bba8699dd9875a))
* **core:** manage outgoing mail sender profiles ([#710](https://github.com/k2b-dev/cloud/issues/710)) ([967022a](https://github.com/k2b-dev/cloud/commit/967022a630204a559ebc2c0aea141a7c448f0f3b))
* **mail:** show mailbox details to everyone who can read it ([#703](https://github.com/k2b-dev/cloud/issues/703)) ([2b5b306](https://github.com/k2b-dev/cloud/commit/2b5b306c1eb913cdeec589bf8eaab665220ce110))


### Bug Fixes

* **ai:** keep every page of chat sources when timestamps share a millisecond ([#706](https://github.com/k2b-dev/cloud/issues/706)) ([7bab886](https://github.com/k2b-dev/cloud/commit/7bab8863ed97f4c3aee41783db44ac0cb83ea717))
* **ai:** keep the live assistant view in sync ([#702](https://github.com/k2b-dev/cloud/issues/702)) ([3e6e1d5](https://github.com/k2b-dev/cloud/commit/3e6e1d5e66c3a05b53a2123337b38817eaaeb76f))
* **ai:** offer runtime tools everywhere and explain missing tools ([#707](https://github.com/k2b-dev/cloud/issues/707)) ([daae0f3](https://github.com/k2b-dev/cloud/commit/daae0f360984de59ba4cbe0adec821d3934dbee8))
* **ai:** report code tool failures as errors ([#698](https://github.com/k2b-dev/cloud/issues/698)) ([3734ed9](https://github.com/k2b-dev/cloud/commit/3734ed9023aee3855a624e3402b812253713ac56))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.16.0 to 0.17.0

## [0.26.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.25.0...npm-cloud-v0.26.0) (2026-10-07)


### ⚠ BREAKING CHANGES

* **ai:** fold finished work into one summary line ([#692](https://github.com/k2b-dev/cloud/issues/692))

### Features

* **access:** show who a group grant actually reaches in the access editor ([#697](https://github.com/k2b-dev/cloud/issues/697)) ([4d0e8b1](https://github.com/k2b-dev/cloud/commit/4d0e8b1a84e67ba5f103881edea9d6bf35682ff3)), closes [#688](https://github.com/k2b-dev/cloud/issues/688)
* **ai:** fold finished work into one summary line ([#692](https://github.com/k2b-dev/cloud/issues/692)) ([b4cd708](https://github.com/k2b-dev/cloud/commit/b4cd708d85581db60c51ebd7a863ea77c32cefca))
* **ai:** retry transient model provider errors ([#687](https://github.com/k2b-dev/cloud/issues/687)) ([5228701](https://github.com/k2b-dev/cloud/commit/5228701e5affb38fe22e6a166dc973ba244c3a48))


### Bug Fixes

* **ai:** show capabilities and approvals in the reader's language ([#682](https://github.com/k2b-dev/cloud/issues/682)) ([2c70089](https://github.com/k2b-dev/cloud/commit/2c700894d34f4b0ef5608931433f41a749dc9a10))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.15.0 to 0.16.0

## [0.25.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.24.0...npm-cloud-v0.25.0) (2026-10-06)


### Features

* **access:** keep at least one manager and show people by name in Grids access ([#677](https://github.com/k2b-dev/cloud/issues/677)) ([6a4aa5c](https://github.com/k2b-dev/cloud/commit/6a4aa5ca207341363af43438269e6bdd04f37b76))
* **browser:** attach files from Cloud apps through one source chooser ([#672](https://github.com/k2b-dev/cloud/issues/672)) ([be21047](https://github.com/k2b-dev/cloud/commit/be21047cabbe011445242a62636fac25fcb3b33f))


### Bug Fixes

* **i18n:** name the admin area Administration in German ([#670](https://github.com/k2b-dev/cloud/issues/670)) ([31d3f56](https://github.com/k2b-dev/cloud/commit/31d3f569b3a8928250a1476e3d3e060ab81c67a6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.14.0 to 0.15.0

## [0.24.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.23.0...npm-cloud-v0.24.0) (2026-10-06)


### ⚠ BREAKING CHANGES

* **ai:** deliver Assistant live updates over the shared live layer ([#652](https://github.com/k2b-dev/cloud/issues/652))

### Features

* **accounts:** tell people when a phone is paired with their account ([#658](https://github.com/k2b-dev/cloud/issues/658)) ([bbe3f6a](https://github.com/k2b-dev/cloud/commit/bbe3f6ab01bb24c31b14bc218be0c6a7189739cc))
* **ai:** deliver Assistant live updates over the shared live layer ([#652](https://github.com/k2b-dev/cloud/issues/652)) ([662c62f](https://github.com/k2b-dev/cloud/commit/662c62fb10b29ee53b1570534beeb85ec756d52c))
* **cloud:** add the file-provider contract and Files provider operations ([#664](https://github.com/k2b-dev/cloud/issues/664)) ([0e22339](https://github.com/k2b-dev/cloud/commit/0e223391e948beaafd6835adaabde7ffcec3dad6))
* **cloud:** read capability manifests from newer Cloud releases ([#662](https://github.com/k2b-dev/cloud/issues/662)) ([c34ae94](https://github.com/k2b-dev/cloud/commit/c34ae942dfb7dd299f4f13b96c8aa0fd127c2966))
* **files:** keep file references stable across rename and move ([#654](https://github.com/k2b-dev/cloud/issues/654)) ([133ae2a](https://github.com/k2b-dev/cloud/commit/133ae2a9f24dabcabd64d49bf933ad01aa9ebc22))
* **pwa:** switch app tabs at the first touch ([#640](https://github.com/k2b-dev/cloud/issues/640)) ([74cad11](https://github.com/k2b-dev/cloud/commit/74cad11ad1accdc9267c90e5fdc7c7695547f802))
* **search:** show fast results at once and say which apps are still searching ([#642](https://github.com/k2b-dev/cloud/issues/642)) ([2997ac7](https://github.com/k2b-dev/cloud/commit/2997ac7d07fa3fe99ed698b7380bd3287b27a8ce))
* **ui:** render info blocks in every Markdown view ([#655](https://github.com/k2b-dev/cloud/issues/655)) ([d1382ed](https://github.com/k2b-dev/cloud/commit/d1382ed0d25ad8ef149e484dbcb401429b6f09fd))


### Bug Fixes

* **cloud:** compute and compare table dates as dates ([#643](https://github.com/k2b-dev/cloud/issues/643)) ([f708d28](https://github.com/k2b-dev/cloud/commit/f708d28b7f557de8f3a00a9a55d29bd709d566b5))
* **cloud:** show a formula error for impossible table dates ([#650](https://github.com/k2b-dev/cloud/issues/650)) ([148fa1c](https://github.com/k2b-dev/cloud/commit/148fa1c91125105ea184c0b2522fffd468b4667e))
* **live:** resync returning subscriptions after access changes they missed ([#666](https://github.com/k2b-dev/cloud/issues/666)) ([7850a18](https://github.com/k2b-dev/cloud/commit/7850a183a1a374bde9e8a48b66b4bbe1a3aa6316))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.13.0 to 0.14.0

## [0.23.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.22.0...npm-cloud-v0.23.0) (2026-10-05)


### Features

* **cloud:** keep live updates quiet when a background tab returns ([#570](https://github.com/k2b-dev/cloud/issues/570)) ([#583](https://github.com/k2b-dev/cloud/issues/583)) ([b075650](https://github.com/k2b-dev/cloud/commit/b0756506e8b42d13e0d50b6138ddf8d2d772d56c))
* **cloud:** let applications add pages to the mobile app ([#609](https://github.com/k2b-dev/cloud/issues/609)) ([bd64ddb](https://github.com/k2b-dev/cloud/commit/bd64ddb620b4597df336b4410019d4392e819461))
* **cloud:** pair phones with long-lived app sessions ([#602](https://github.com/k2b-dev/cloud/issues/602)) ([cdea338](https://github.com/k2b-dev/cloud/commit/cdea3389f00c73d247ab431f919ccb2a19fbdb83))
* **events:** write live updates in the domain transaction through one platform outbox ([#599](https://github.com/k2b-dev/cloud/issues/599)) ([864f459](https://github.com/k2b-dev/cloud/commit/864f459465f7c39a0af21b053fa7a6504af987c2))
* **live:** serve live channels over one socket per app and check access at delivery ([#610](https://github.com/k2b-dev/cloud/issues/610)) ([2a77a14](https://github.com/k2b-dev/cloud/commit/2a77a14583f407e02887497b50e755eb60ededab))
* **pwa:** add the installable mobile app ([#605](https://github.com/k2b-dev/cloud/issues/605)) ([27e42cc](https://github.com/k2b-dev/cloud/commit/27e42cc1eccaf4b1943645fcb7cf34855507bc22))


### Bug Fixes

* **ai:** stop the turn stream when access ends and report errors instead of retrying forever ([#606](https://github.com/k2b-dev/cloud/issues/606)) ([b6f6fb5](https://github.com/k2b-dev/cloud/commit/b6f6fb57ea3974e3ef4d0df0b910b4b63789202e))
* **events:** keep live updates flowing under load and behind one busy key ([#620](https://github.com/k2b-dev/cloud/issues/620)) ([a6a15bf](https://github.com/k2b-dev/cloud/commit/a6a15bf3e7ac37ffc514b63768c94fa53ef9d034))
* give every detail panel section the same flat frame, comments included ([#592](https://github.com/k2b-dev/cloud/issues/592)) ([42e81a6](https://github.com/k2b-dev/cloud/commit/42e81a6a6d9ff36d01fda71b73ac23b5a423795c))
* **live:** stop live engine timers before Sync shuts down ([#637](https://github.com/k2b-dev/cloud/issues/637)) ([390c15a](https://github.com/k2b-dev/cloud/commit/390c15ae92a781a21f82d94ee018fd2a2dc07a44))
* **mail:** share one live connection per tab for the mailbox, composer and dialogs ([#630](https://github.com/k2b-dev/cloud/issues/630)) ([da155cf](https://github.com/k2b-dev/cloud/commit/da155cf1d00cc564c343bc24a59540ff95b69bf3))
* **pwa:** open app pages on the first tap and check off tasks instantly ([#622](https://github.com/k2b-dev/cloud/issues/622)) ([0c063eb](https://github.com/k2b-dev/cloud/commit/0c063ebcd856cfd4991a2830d0fc940bd4cdf9ec))
* **ui:** keep icons the same width while the icon font loads ([#581](https://github.com/k2b-dev/cloud/issues/581)) ([cb58bbc](https://github.com/k2b-dev/cloud/commit/cb58bbc157f8f838c442d4c06036701358ff27f5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.12.0 to 0.13.0

## [0.22.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.21.1...npm-cloud-v0.22.0) (2026-10-03)


### Features

* **ui:** calmer Markdown tables, quotes and code ([#561](https://github.com/k2b-dev/cloud/issues/561)) ([666ebae](https://github.com/k2b-dev/cloud/commit/666ebae2669bcc2054ed964dab64231464ab54e5))
* **ui:** group dialog sections without frames ([#558](https://github.com/k2b-dev/cloud/issues/558)) ([e6ec679](https://github.com/k2b-dev/cloud/commit/e6ec67959355bbca8c296b1cd64d76714dc9a402))
* **ui:** show toasts as one calm line ([#536](https://github.com/k2b-dev/cloud/issues/536)) ([8b3b358](https://github.com/k2b-dev/cloud/commit/8b3b358ee3c627e5b58cd037d7cee3bbb8c5f692))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.11.0 to 0.12.0

## [0.21.1](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.21.0...npm-cloud-v0.21.1) (2026-10-01)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.10.0 to 0.11.0

## [0.21.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.20.0...npm-cloud-v0.21.0) (2026-10-01)


### ⚠ BREAKING CHANGES

* **assistant:** the exported browser-safe type `AiChatQuotaSnapshot` and `GET /api/ai/quotas` (and `getAiChatQuotas()`) no longer carry money: `unit`, `limit`, `used`, `input`, `output`, and `estimated` are gone. Each balance is now `{ scope, unlimited, usedPercent, resetsAt }`. `usedPercent` is a whole number from 0 to 100, reaches 100 only when the allowance is used up, and is `null` when the allowance is unlimited or cannot be measured. Administrators still configure allowances in money in the admin settings, and the administrator endpoints keep amounts.

### Features

* **assistant:** show chat usage as a quiet ring without money ([#486](https://github.com/k2b-dev/cloud/issues/486)) ([27f6b77](https://github.com/k2b-dev/cloud/commit/27f6b7721c44d5328387c5cdfa99b1473f22a84a))
* **cloud:** show sign-in and other simple pages without a card on phones ([#481](https://github.com/k2b-dev/cloud/issues/481)) ([d6a805e](https://github.com/k2b-dev/cloud/commit/d6a805e462f968a1c472ef0289fee3d74f8c8a2c))
* **ui:** keep focus rings visible inside clipping containers ([#484](https://github.com/k2b-dev/cloud/issues/484)) ([b5051f9](https://github.com/k2b-dev/cloud/commit/b5051f99cd6238c12cd7f99aac1e25803a488b8a))


### Bug Fixes

* **cloud:** keep focus rings whole on flat standalone cards on phones ([#498](https://github.com/k2b-dev/cloud/issues/498)) ([ecd61ee](https://github.com/k2b-dev/cloud/commit/ecd61ee52cd56e0015949f7334b76128af449697))
* **cloud:** keep starting until NATS and JetStream answer instead of staying unhealthy ([#482](https://github.com/k2b-dev/cloud/issues/482)) ([d3c8cdc](https://github.com/k2b-dev/cloud/commit/d3c8cdc61c4d1914756724cdfb91c3f40e7e1ec5))
* **cloud:** preload the Latin Plex faces so pages keep their first-frame layout ([#483](https://github.com/k2b-dev/cloud/issues/483)) ([82bbf3f](https://github.com/k2b-dev/cloud/commit/82bbf3fa65bcc00178b400f2f28ebba5b5e28823))
* **cloud:** show each service account's kind the same way in access editors, pickers, and cost limits ([#488](https://github.com/k2b-dev/cloud/issues/488)) ([89f9db9](https://github.com/k2b-dev/cloud/commit/89f9db99f7091d9b1001e27d24197538308f3cc4))
* keep phone footers on finger-sized targets with a compact language and theme control ([#510](https://github.com/k2b-dev/cloud/issues/510)) ([2a2f564](https://github.com/k2b-dev/cloud/commit/2a2f564fd3ae0bfc5f0f928ec3bcf36dbcd23a4f))
* **ui:** give icon-only controls a tooltip with their label ([#497](https://github.com/k2b-dev/cloud/issues/497)) ([f3119bc](https://github.com/k2b-dev/cloud/commit/f3119bc687158c0209699273e77798ab08b53664))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.9.1 to 0.10.0

## [0.20.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.19.0...npm-cloud-v0.20.0) (2026-09-30)


### ⚠ BREAKING CHANGES

* **files:** remove the legacy Files app ([#465](https://github.com/k2b-dev/cloud/issues/465))

### Features

* **cloud:** document the real validation error in every OpenAPI route ([#459](https://github.com/k2b-dev/cloud/issues/459)) ([d2a080d](https://github.com/k2b-dev/cloud/commit/d2a080db520577bad87bf77a375fa25cd489058e))
* **cloud:** end public minimal pages with legal links and labeled language and theme settings ([#446](https://github.com/k2b-dev/cloud/issues/446)) ([163cc8f](https://github.com/k2b-dev/cloud/commit/163cc8fd9e64228eb385f2088f40ac50af2f63f2))
* **cloud:** move to @k2b/sync 7 and bound dead-letter storage for topics ([#467](https://github.com/k2b-dev/cloud/issues/467)) ([e4c2397](https://github.com/k2b-dev/cloud/commit/e4c2397897e3eac6dfd81afabeae98b4319d399b))
* **cloud:** reserve small JetStream budgets for Sync jobs and queues by default ([#449](https://github.com/k2b-dev/cloud/issues/449)) ([8304632](https://github.com/k2b-dev/cloud/commit/830463293e3361b808d3daab6bf5f4b6db30938f)), closes [#362](https://github.com/k2b-dev/cloud/issues/362)
* **cloud:** set the Gotenberg URL from GOTENBERG_URL ([#456](https://github.com/k2b-dev/cloud/issues/456)) ([e49fadc](https://github.com/k2b-dev/cloud/commit/e49fadcbbb27fb7d00058f12678ce0f79843d7c6))
* **files:** remove the legacy Files app ([#465](https://github.com/k2b-dev/cloud/issues/465)) ([f6a6a2f](https://github.com/k2b-dev/cloud/commit/f6a6a2fb41337044611e83d7b0de478d56159de3))
* **notebooks:** render info boxes and other note blocks in PDF exports ([#444](https://github.com/k2b-dev/cloud/issues/444)) ([2602a44](https://github.com/k2b-dev/cloud/commit/2602a44b4ad437718a746b208113e980af191eb9))


### Bug Fixes

* **cloud:** form ligatures in report PDFs ([#452](https://github.com/k2b-dev/cloud/issues/452)) ([d88e867](https://github.com/k2b-dev/cloud/commit/d88e867a30fe92a002e2adb5b506c4ec956a5019))
* **cloud:** pick the first supported language from the browser ([#450](https://github.com/k2b-dev/cloud/issues/450)) ([51a18da](https://github.com/k2b-dev/cloud/commit/51a18da275968482d7968500731035e85459b9a2))
* **cloud:** stop app pages from coming back stale from the browser cache ([#442](https://github.com/k2b-dev/cloud/issues/442)) ([5669879](https://github.com/k2b-dev/cloud/commit/566987982580284f1a56d966287861e7ebe7d74f))
* **deps:** move to @k2b/stdlib 0.27.0 and show dates in each locale's order ([#472](https://github.com/k2b-dev/cloud/issues/472)) ([163ace1](https://github.com/k2b-dev/cloud/commit/163ace136dd89d587a700d579df9a42502d71f60))
* **deps:** move to marked 18 ([#474](https://github.com/k2b-dev/cloud/issues/474)) ([5dd1d3a](https://github.com/k2b-dev/cloud/commit/5dd1d3aca52b03744fc0059fc5619a32e9972143)), closes [#463](https://github.com/k2b-dev/cloud/issues/463)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.9.0 to 0.9.1

## [0.19.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.18.0...npm-cloud-v0.19.0) (2026-09-29)


### Features

* **cloud:** give rendered PDFs their document title instead of a random file name ([#431](https://github.com/k2b-dev/cloud/issues/431)) ([325ce15](https://github.com/k2b-dev/cloud/commit/325ce1543eedda32b66eec36e2c43a98867c7255))


### Bug Fixes

* **cloud:** keep Tailwind utilities above the property fallback layer in older browsers ([#426](https://github.com/k2b-dev/cloud/issues/426)) ([6729676](https://github.com/k2b-dev/cloud/commit/672967631f061eaee49ca8f87379801568ece666))
* **mail:** insert template placeholders as plain text and send links without brackets ([#394](https://github.com/k2b-dev/cloud/issues/394)) ([61145ab](https://github.com/k2b-dev/cloud/commit/61145abf68fe2c8fce5b927ae2a38562dc70e508))
* **notebooks:** keep phone menu folds and settings categories usable on narrow screens ([#416](https://github.com/k2b-dev/cloud/issues/416)) ([4bedff0](https://github.com/k2b-dev/cloud/commit/4bedff059361d3f711e60d94a4f4fad5ef85da29))
* **ui:** keep phone header and settings close touch targets finger-sized without overlap ([#424](https://github.com/k2b-dev/cloud/issues/424)) ([9024d79](https://github.com/k2b-dev/cloud/commit/9024d7948687182472381dd1063301a975ae02a3))
* **ui:** keep phone tap areas clear of neighbouring controls and give the header Home link a finger-sized target ([#433](https://github.com/k2b-dev/cloud/issues/433)) ([b0be346](https://github.com/k2b-dev/cloud/commit/b0be34624d7840f0f4e87a4691958b9a47b899d5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.8.0 to 0.9.0

## [0.18.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.17.0...npm-cloud-v0.18.0) (2026-09-28)


### Features

* **accounts:** allow local accounts without email when enabled ([#371](https://github.com/k2b-dev/cloud/issues/371)) ([9b46e69](https://github.com/k2b-dev/cloud/commit/9b46e6964d558eeee8af77e132707cf5cfc79400))
* **accounts:** let admins revoke a user's paired sign-in devices ([#369](https://github.com/k2b-dev/cloud/issues/369)) ([a0ac811](https://github.com/k2b-dev/cloud/commit/a0ac8115b555172b042051a63abb27170344867b))
* **assistant:** turn HTML with CSS into PDF ([#367](https://github.com/k2b-dev/cloud/issues/367)) ([f3467ea](https://github.com/k2b-dev/cloud/commit/f3467eadb0649f6f28b6e0f36599195626eed994))
* **cloud:** render every HTML-to-PDF path offline ([#354](https://github.com/k2b-dev/cloud/issues/354)) ([5c2f159](https://github.com/k2b-dev/cloud/commit/5c2f159439b3b3c8a8d69651d051e1043c388597))
* **pwa-auth:** show which account each connected Cloud signs in ([#358](https://github.com/k2b-dev/cloud/issues/358)) ([a123878](https://github.com/k2b-dev/cloud/commit/a123878ce8b1cde33130bce98dc758a897a78603))


### Bug Fixes

* **cloud:** use the flat app background on phones in dark mode ([#376](https://github.com/k2b-dev/cloud/issues/376)) ([b8c465f](https://github.com/k2b-dev/cloud/commit/b8c465f7d7309d97412dd9c9cfb97658d090f1e0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.7.0 to 0.8.0

## [0.17.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.16.1...npm-cloud-v0.17.0) (2026-09-27)


### Features

* **assistant:** delete chat files from the Files list ([#347](https://github.com/k2b-dev/cloud/issues/347)) ([5246601](https://github.com/k2b-dev/cloud/commit/52466014b27cc5405041ecfe4a8c01fe9709483a))


### Bug Fixes

* **cloud:** keep lone reasoning rows at the full chat column width ([#340](https://github.com/k2b-dev/cloud/issues/340)) ([cc85a41](https://github.com/k2b-dev/cloud/commit/cc85a41f9670f51656eaab2bdcfb63a4ae13c07e))
* **test:** delete the Sync namespaces integration tests leave on the broker ([#328](https://github.com/k2b-dev/cloud/issues/328)) ([42709f2](https://github.com/k2b-dev/cloud/commit/42709f232cd8bd1489b32f5db40f09781b370edd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.6.3 to 0.7.0

## [0.16.1](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.16.0...npm-cloud-v0.16.1) (2026-09-27)


### Bug Fixes

* **cloud:** keep mixed token colors in compiled stylesheets ([#319](https://github.com/k2b-dev/cloud/issues/319)) ([9b9e937](https://github.com/k2b-dev/cloud/commit/9b9e937fcb10cc8cff9be794e42f851d1993ec28)), closes [#315](https://github.com/k2b-dev/cloud/issues/315)
* **cloud:** keep the PDF decoder within its memory limit on many-core hosts ([#318](https://github.com/k2b-dev/cloud/issues/318)) ([94cb4ff](https://github.com/k2b-dev/cloud/commit/94cb4ffd73f1f12f2a8e9d06a3174fa12bf004f6)), closes [#314](https://github.com/k2b-dev/cloud/issues/314)
* **cloud:** show agent and standalone service-account grants in access list tables ([#306](https://github.com/k2b-dev/cloud/issues/306)) ([4114ccf](https://github.com/k2b-dev/cloud/commit/4114ccf921215a56be2545c86a54b7ca3e4a1c36)), closes [#295](https://github.com/k2b-dev/cloud/issues/295)
* **cloud:** stop page content from shifting when the scrollbar appears ([#309](https://github.com/k2b-dev/cloud/issues/309)) ([aef9539](https://github.com/k2b-dev/cloud/commit/aef9539bb169a87693f24d98a7783df116d4c80e)), closes [#287](https://github.com/k2b-dev/cloud/issues/287)

## [0.16.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.15.0...npm-cloud-v0.16.0) (2026-09-26)


### ⚠ BREAKING CHANGES

* **cli:** write the cloud-cli agent skill with every installed module's references ([#265](https://github.com/k2b-dev/cloud/issues/265))
* **cli:** serve every first-party module as a plugin of its application ([#261](https://github.com/k2b-dev/cloud/issues/261))

### Features

* **cli:** serve every first-party module as a plugin of its application ([#261](https://github.com/k2b-dev/cloud/issues/261)) ([40a9690](https://github.com/k2b-dev/cloud/commit/40a9690ce5843a08bbc60e5117fb967be9e51396))
* **cli:** write the cloud-cli agent skill with every installed module's references ([#265](https://github.com/k2b-dev/cloud/issues/265)) ([f02142d](https://github.com/k2b-dev/cloud/commit/f02142d56db75451401e304bf9e96e0bdbd336ea))
* **cloud:** serve each app's cld plugin and skill references from the app ([#253](https://github.com/k2b-dev/cloud/issues/253)) ([c89ffa0](https://github.com/k2b-dev/cloud/commit/c89ffa0d4dd6406d9d0246844ff307a0f31c6e54))
* **core:** merge the account overview into the profile page ([#260](https://github.com/k2b-dev/cloud/issues/260)) ([8eb4540](https://github.com/k2b-dev/cloud/commit/8eb45401efc55ff470fa8e51e1ef9488adb39988))


### Bug Fixes

* **core:** polish account pages and settings source labels ([#259](https://github.com/k2b-dev/cloud/issues/259)) ([c73dbf8](https://github.com/k2b-dev/cloud/commit/c73dbf80b3bd345b8aa5036ef0f5d99f3fc51d5a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.6.2 to 0.6.3

## [0.15.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.14.0...npm-cloud-v0.15.0) (2026-09-26)


### Features

* **cli:** share the command convention and address parsing for app CLIs ([#244](https://github.com/k2b-dev/cloud/issues/244)) ([3567c29](https://github.com/k2b-dev/cloud/commit/3567c29be73fd11522cde91516b0da119366ea51))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.6.1 to 0.6.2

## [0.14.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.13.0...npm-cloud-v0.14.0) (2026-09-25)


### Features

* **cloud:** send sign-in push hints to paired devices ([#232](https://github.com/k2b-dev/cloud/issues/232)) ([7227cff](https://github.com/k2b-dev/cloud/commit/7227cff17d30bb31ed7ae8bedfc327e934aa27dc))
* **notebooks:** show callout blocks with colour only ([#226](https://github.com/k2b-dev/cloud/issues/226)) ([e75336d](https://github.com/k2b-dev/cloud/commit/e75336dc59f29d0b9f80a3b2bd58ae9039132ea1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.6.0 to 0.6.1

## [0.13.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.12.0...npm-cloud-v0.13.0) (2026-09-24)


### Features

* **accounts:** capitalise group names for display in German ([#202](https://github.com/k2b-dev/cloud/issues/202)) ([08b34e9](https://github.com/k2b-dev/cloud/commit/08b34e9a5d7e57da8d406a88b1c85644ba7cb0b1))
* **accounts:** hide personal Linux groups from group lists and pickers by default ([#197](https://github.com/k2b-dev/cloud/issues/197)) ([1e640c4](https://github.com/k2b-dev/cloud/commit/1e640c453cdb83bb87f8f405cb93b843f71ac475))


### Bug Fixes

* **cloud:** bound automatic page reloads so live errors cannot loop ([#221](https://github.com/k2b-dev/cloud/issues/221)) ([cd513d8](https://github.com/k2b-dev/cloud/commit/cd513d8f4220612a966ffc5517d4e4e05dd944b5))
* **core:** delete passkeys reliably and explain failures ([#203](https://github.com/k2b-dev/cloud/issues/203)) ([b72e51f](https://github.com/k2b-dev/cloud/commit/b72e51f6c3ec1b2004be0509c400f1787abe13d6))
* **core:** finish app sign-in immediately without flashing the form ([#191](https://github.com/k2b-dev/cloud/issues/191)) ([074825d](https://github.com/k2b-dev/cloud/commit/074825df64a25681787b848be83b668dd37c044b))
* **ui:** align entity search results left with the action on the right ([#192](https://github.com/k2b-dev/cloud/issues/192)) ([8f34e22](https://github.com/k2b-dev/cloud/commit/8f34e22db573839de5831992d8f9a5d6e00a9ed1))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.5.1 to 0.6.0

## [0.12.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.11.1...npm-cloud-v0.12.0) (2026-09-23)


### Features

* **notebooks:** render diagrams with mermaid 12 ([#181](https://github.com/k2b-dev/cloud/issues/181)) ([5a41b0a](https://github.com/k2b-dev/cloud/commit/5a41b0a47537bae93daa3ddd26aa04c5014462db))


### Bug Fixes

* **cloud:** recover stalled live connections when a tab or network returns ([#184](https://github.com/k2b-dev/cloud/issues/184)) ([230c402](https://github.com/k2b-dev/cloud/commit/230c4026cf11cd353127664e1157b872c3f1cccb))
* page notifications, bases and telemetry with a stable order ([#182](https://github.com/k2b-dev/cloud/issues/182)) ([b04cffb](https://github.com/k2b-dev/cloud/commit/b04cffb535b244562ff5f29d6e5e044d7219852d))

## [0.11.1](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.11.0...npm-cloud-v0.11.1) (2026-09-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.5.0 to 0.5.1

## [0.11.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.10.2...npm-cloud-v0.11.0) (2026-09-23)


### Features

* **notebooks:** share one Yjs log across notes so JetStream reservations stay constant ([#168](https://github.com/k2b-dev/cloud/issues/168)) ([977d1d2](https://github.com/k2b-dev/cloud/commit/977d1d2d0b91b53caa408f9f4d61db0876f06f05))

## [0.10.2](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.10.1...npm-cloud-v0.10.2) (2026-09-23)


### Bug Fixes

* **ai:** explain which setting blocks removing a model profile ([#139](https://github.com/k2b-dev/cloud/issues/139)) ([45aafcd](https://github.com/k2b-dev/cloud/commit/45aafcd930bdab910bfba1904c9a988c0dd68ce1))

## [0.10.1](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.10.0...npm-cloud-v0.10.1) (2026-09-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.4.2 to 0.5.0

## [0.10.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.9.1...npm-cloud-v0.10.0) (2026-09-22)


### Features

* **ai:** show hosted reasoning streams and keep per-call timings and errors ([#122](https://github.com/k2b-dev/cloud/issues/122)) ([f6d781f](https://github.com/k2b-dev/cloud/commit/f6d781fadcad4c2ef426a3ece2d280c0a9c9abc4))
* **assistant:** write ODS workbooks in code mode ([#113](https://github.com/k2b-dev/cloud/issues/113)) ([163e285](https://github.com/k2b-dev/cloud/commit/163e28514ffe103741ce5e0c404e16034a48580b)), closes [#112](https://github.com/k2b-dev/cloud/issues/112)
* **grids:** return download links for every generated document ([#114](https://github.com/k2b-dev/cloud/issues/114)) ([5e3cbe2](https://github.com/k2b-dev/cloud/commit/5e3cbe22cefdc5f14d2c10623fc60c057f2b6a73))


### Bug Fixes

* **ai:** resolve Unicode-equivalent file names consistently ([#121](https://github.com/k2b-dev/cloud/issues/121)) ([70a0d78](https://github.com/k2b-dev/cloud/commit/70a0d78c548cb2db8212eef2605b93302ed7e207)), closes [#119](https://github.com/k2b-dev/cloud/issues/119)

## [0.9.1](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.9.0...npm-cloud-v0.9.1) (2026-09-22)


### Bug Fixes

* **accounts:** keep user deletion from failing after the row is gone ([#111](https://github.com/k2b-dev/cloud/issues/111)) ([a6b67d7](https://github.com/k2b-dev/cloud/commit/a6b67d77db0c25a535fced0e616cb50db6d61b05)), closes [#107](https://github.com/k2b-dev/cloud/issues/107)
* **cloud:** give the mobile launchpad the full sheet when an app has no menu ([#106](https://github.com/k2b-dev/cloud/issues/106)) ([c58af23](https://github.com/k2b-dev/cloud/commit/c58af233e73f3ee1fe355b9b94c0b54b35742109)), closes [#101](https://github.com/k2b-dev/cloud/issues/101)
* **filesv2:** resolve bundled document templates and name the failing step ([#104](https://github.com/k2b-dev/cloud/issues/104)) ([18bd9fd](https://github.com/k2b-dev/cloud/commit/18bd9fdeb38df023286ed8ccc67b54576fb2eb48)), closes [#100](https://github.com/k2b-dev/cloud/issues/100)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.4.1 to 0.4.2

## [0.9.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.8.0...npm-cloud-v0.9.0) (2026-09-22)


### Features

* **cloud:** ship server-side application assets with the bundle ([#73](https://github.com/k2b-dev/cloud/issues/73)) ([52f818c](https://github.com/k2b-dev/cloud/commit/52f818cb4a627e55ee77e140493391357c6fd15e)), closes [#66](https://github.com/k2b-dev/cloud/issues/66)
* **core:** request sign-in links with the username ([#64](https://github.com/k2b-dev/cloud/issues/64)) ([e487187](https://github.com/k2b-dev/cloud/commit/e487187acc14f5fc57ebcada1f7fb85c236bcce2)), closes [#62](https://github.com/k2b-dev/cloud/issues/62)


### Bug Fixes

* **cloud:** make revoke-during-verification API key test deterministic ([#58](https://github.com/k2b-dev/cloud/issues/58)) ([5caf896](https://github.com/k2b-dev/cloud/commit/5caf896ea3dbe3ca98bf97ebe4908c1516bbf6af))
* **mail:** keep the workspace route relative across SSR hydration ([#90](https://github.com/k2b-dev/cloud/issues/90)) ([ccbd143](https://github.com/k2b-dev/cloud/commit/ccbd143df212065180c1c860f7e4cbe006cbfe54)), closes [#86](https://github.com/k2b-dev/cloud/issues/86)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.4.0 to 0.4.1

## [0.8.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.7.0...npm-cloud-v0.8.0) (2026-09-21)


### Features

* adopt a release train with gated CI and one configuration model ([7fa46ac](https://github.com/k2b-dev/cloud/commit/7fa46ac88f7af9fe5c58152beae2bda5180fcd55))
* **assistant:** run scheduled code with task-scoped grants ([#33](https://github.com/k2b-dev/cloud/issues/33)) ([391572e](https://github.com/k2b-dev/cloud/commit/391572e5c62341f735bea12bc9f099758531691b)), closes [#15](https://github.com/k2b-dev/cloud/issues/15)
* **filesv2:** download private files from resource references ([35e3d7f](https://github.com/k2b-dev/cloud/commit/35e3d7f834d2ddbc27bcaecc2d3f2d80038b4489))
* **grids:** download document folders and expose authenticated file links ([#23](https://github.com/k2b-dev/cloud/issues/23)) ([fb2725a](https://github.com/k2b-dev/cloud/commit/fb2725afb463f42224f8f616d9684873641d8837))


### Bug Fixes

* **ai:** rank fuzzy name matches above description hits in skill search ([#35](https://github.com/k2b-dev/cloud/issues/35)) ([92b620f](https://github.com/k2b-dev/cloud/commit/92b620f375afbf842d14a8993a5fd969511e8d74)), closes [#34](https://github.com/k2b-dev/cloud/issues/34)
* **cloud:** re-enable the request-cache outage test ([#24](https://github.com/k2b-dev/cloud/issues/24)) ([03d6b49](https://github.com/k2b-dev/cloud/commit/03d6b49963680708d29508850f91c798c44ea7ea)), closes [#9](https://github.com/k2b-dev/cloud/issues/9)
* **core:** answer 401 for an invalid emergency recovery token ([#30](https://github.com/k2b-dev/cloud/issues/30)) ([40d45fd](https://github.com/k2b-dev/cloud/commit/40d45fdc2c1072009e5103710f0ab42a35d897c4)), closes [#4](https://github.com/k2b-dev/cloud/issues/4)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.3.0 to 0.4.0
