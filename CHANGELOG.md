# Changelog

release-please maintains this file from the next release on. Do not edit it by
hand; entries come from squash-commit titles on `main`.

## [0.37.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.36.0...cloud-v0.37.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* **mail:** let conversations have several assignees and grant access to assigned conversations only ([#830](https://github.com/k2b-dev/cloud/issues/830))

### Features

* **ai:** show charts directly in the chat without building an app ([#847](https://github.com/k2b-dev/cloud/issues/847)) ([18a129d](https://github.com/k2b-dev/cloud/commit/18a129dcb05d9ed4043a7a416b2c6cca727997c6))
* **capabilities:** let apps word their own approval and receipt sentences ([#846](https://github.com/k2b-dev/cloud/issues/846)) ([cc5a4d6](https://github.com/k2b-dev/cloud/commit/cc5a4d69d03f42f10ebd67b3b91ab0bd83c7386b)), closes [#811](https://github.com/k2b-dev/cloud/issues/811)
* **cloud:** let apps ship their own Assistant skills ([#840](https://github.com/k2b-dev/cloud/issues/840)) ([d0b1ac6](https://github.com/k2b-dev/cloud/commit/d0b1ac6db6d3199b072684704f84dc0a74d6a506))
* **cloud:** show Help only to people who may open the app ([#827](https://github.com/k2b-dev/cloud/issues/827)) ([cce4f28](https://github.com/k2b-dev/cloud/commit/cce4f280fc39e5b90647bccebef4ac2dbbde90dd))
* **dashboard:** stream widgets in as they load instead of failing the whole board ([#831](https://github.com/k2b-dev/cloud/issues/831)) ([e7ff2ce](https://github.com/k2b-dev/cloud/commit/e7ff2ce2c13a4a6e2e49fc4c2ef7b9a236ca78b9))
* **mail:** let conversations have several assignees and grant access to assigned conversations only ([#830](https://github.com/k2b-dev/cloud/issues/830)) ([631c73a](https://github.com/k2b-dev/cloud/commit/631c73a05bf8eafe74b0af61920237657678193a))
* **spaces:** remove the timeline view ([#798](https://github.com/k2b-dev/cloud/issues/798)) ([ca4f890](https://github.com/k2b-dev/cloud/commit/ca4f89045130cca74bc75107b153b534fb0b3c20))
* **spaces:** select days, create over a range, and show long events as one bar in the month view ([#826](https://github.com/k2b-dev/cloud/issues/826)) ([ed10713](https://github.com/k2b-dev/cloud/commit/ed1071320af6a09e177d4115f15328bcfb7bc8a7))
* **ui:** mark today in every date picker ([#839](https://github.com/k2b-dev/cloud/issues/839)) ([de47b30](https://github.com/k2b-dev/cloud/commit/de47b3010ac5a6f0ef32aff638edaa30dadf50d2))


### Bug Fixes

* **ai:** keep code runs from failing while they wait for an approval ([#832](https://github.com/k2b-dev/cloud/issues/832)) ([cbdaa0f](https://github.com/k2b-dev/cloud/commit/cbdaa0fee308e890fd940b242d8d2ce6c78bc2f2))
* **notebooks:** count lines through a mirror file as the file shows them, in cat and edit ([#802](https://github.com/k2b-dev/cloud/issues/802)) ([de3f6d2](https://github.com/k2b-dev/cloud/commit/de3f6d23d2d547ae07eae6f35d8d43c1da7469cc))
* **ui:** keep busy buttons at their width and name them by their loading label ([#845](https://github.com/k2b-dev/cloud/issues/845)) ([1bd875a](https://github.com/k2b-dev/cloud/commit/1bd875ae479b276cdcea6e3d11a1f95cc1257325))
* **ui:** show bare dialogs on iPad instead of only blurring the page ([#799](https://github.com/k2b-dev/cloud/issues/799)) ([285b00f](https://github.com/k2b-dev/cloud/commit/285b00ff6b655443e468bf6e167a82ad5ffd2fec))


### Performance Improvements

* keep Zod, KaTeX, Liquid and on-demand dialogs out of the shell and Mail first load ([#851](https://github.com/k2b-dev/cloud/issues/851)) ([90d919a](https://github.com/k2b-dev/cloud/commit/90d919ac1ab8ca65c8b99d0e7617824c73ce9e69))

## [0.36.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.35.0...cloud-v0.36.0) (2026-10-09)


### Features

* **ui:** add swipe, long-press and double-tap gestures ([#786](https://github.com/k2b-dev/cloud/issues/786)) ([6f72eae](https://github.com/k2b-dev/cloud/commit/6f72eae8d64a6d9f5a728a93e6cee31e83a04579))


### Bug Fixes

* **cloud:** document the Postgres outbox and public HTTPS fetch, and end an outbox batch with its claim ([#787](https://github.com/k2b-dev/cloud/issues/787)) ([d613448](https://github.com/k2b-dev/cloud/commit/d6134480ce7f2ce3f3fe1cd488a30896d76f3899))
* **scripts:** run one heavy check or test run per machine with bounded type checkers ([#791](https://github.com/k2b-dev/cloud/issues/791)) ([bbc4932](https://github.com/k2b-dev/cloud/commit/bbc493290e9088dbbf2c3f14b4ea141a6609eca5))
* **ui:** keep phone keyboards from capitalizing user names and addresses ([#792](https://github.com/k2b-dev/cloud/issues/792)) ([5b9b9a1](https://github.com/k2b-dev/cloud/commit/5b9b9a14d91593014a8f1f71e50d4e5e650b2a6b))
* **ui:** keep short table columns readable next to long ones ([#785](https://github.com/k2b-dev/cloud/issues/785)) ([4f12a78](https://github.com/k2b-dev/cloud/commit/4f12a7807795dc66e68e38d834bb7be4e8ed2967))
* **ui:** keep the chat composer's formatting row short and aligned with the field ([#789](https://github.com/k2b-dev/cloud/issues/789)) ([ae018fc](https://github.com/k2b-dev/cloud/commit/ae018fc7a8a27389aaad7bd33aeb89f78d2ed607))

## [0.35.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.34.0...cloud-v0.35.0) (2026-10-09)


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
* **oauth:** approve a device or app on a calm, centered page ([#755](https://github.com/k2b-dev/cloud/issues/755)) ([baff695](https://github.com/k2b-dev/cloud/commit/baff695581dcc4a1217d7096f177cdccdaf83cbb))
* save attachments into Files from Mail and other apps ([#765](https://github.com/k2b-dev/cloud/issues/765)) ([a6d9ae9](https://github.com/k2b-dev/cloud/commit/a6d9ae939a94886750904160ab904524b1e79d45))
* **spaces:** add a timeline calendar view ([#763](https://github.com/k2b-dev/cloud/issues/763)) ([fae29fa](https://github.com/k2b-dev/cloud/commit/fae29fa06de80b69059ab04f794ff7eedde59a76))
* **spaces:** add task and event templates ([#764](https://github.com/k2b-dev/cloud/issues/764)) ([8c98ecd](https://github.com/k2b-dev/cloud/commit/8c98ecd44e17bf517554caad1c74eb9051d2b076))
* **spaces:** color calendar items by their tags and choose what the color shows ([#754](https://github.com/k2b-dev/cloud/issues/754)) ([c396691](https://github.com/k2b-dev/cloud/commit/c3966915d0fdaaef59182a7d75d99f8035dcf5aa))
* **spaces:** say which tasks are overdue in task lists ([#774](https://github.com/k2b-dev/cloud/issues/774)) ([9dcfb7e](https://github.com/k2b-dev/cloud/commit/9dcfb7e2040d1206ea634ffe4e0287811a8362b3))
* **spaces:** show overdue and undated tasks under the timeline ([#773](https://github.com/k2b-dev/cloud/issues/773)) ([d7168ea](https://github.com/k2b-dev/cloud/commit/d7168ea01de889b2f21bb3cade436c1ac69f799e))
* **ui:** add a resource card that keeps its height in every state ([#746](https://github.com/k2b-dev/cloud/issues/746)) ([01c1a95](https://github.com/k2b-dev/cloud/commit/01c1a95d60fff513fa574bec9f1384584ce0c974))
* **ui:** add a SignatureInput that draws with finger, pen or mouse or types the name ([#782](https://github.com/k2b-dev/cloud/issues/782)) ([b85ebd8](https://github.com/k2b-dev/cloud/commit/b85ebd8bef26699613b8e3c56d209944b17f7efc)), closes [#708](https://github.com/k2b-dev/cloud/issues/708)
* **ui:** add a Timeline that shows time as a continuous filmstrip ([#751](https://github.com/k2b-dev/cloud/issues/751)) ([fe0980d](https://github.com/k2b-dev/cloud/commit/fe0980d684e6b0a7596737aa8abd18e9cd3658da))
* **ui:** add an emoji picker with search, recents and skin tones ([#778](https://github.com/k2b-dev/cloud/issues/778)) ([1e291a9](https://github.com/k2b-dev/cloud/commit/1e291a9b5e3f4dc69b25a50bdef30ddef97f89c0))
* **ui:** grow the chat composer from one line with formatting on demand ([#770](https://github.com/k2b-dev/cloud/issues/770)) ([d5e7ff2](https://github.com/k2b-dev/cloud/commit/d5e7ff2c5f4b222ec20a59ac3756728f165274ba))
* **ui:** show counts, dots and mention marks in sidebar items ([#756](https://github.com/k2b-dev/cloud/issues/756)) ([16122af](https://github.com/k2b-dev/cloud/commit/16122afd3883741c79911ef6753758160443742d))


### Bug Fixes

* **ai:** keep Assistant turns working when an older CLI offers retired client tools ([#760](https://github.com/k2b-dev/cloud/issues/760)) ([f9598e7](https://github.com/k2b-dev/cloud/commit/f9598e74585ef1c358bb5fb64fe426ef7283f6f9))
* **ai:** keep scheduled runs inside their grants instead of failing on a tool they may not use ([#776](https://github.com/k2b-dev/cloud/issues/776)) ([5b1f50e](https://github.com/k2b-dev/cloud/commit/5b1f50eae763bc74165dbb06812632530e1fcc28))
* **ai:** offer audio transcription only when it can run and say why when it cannot ([#748](https://github.com/k2b-dev/cloud/issues/748)) ([f63fc3f](https://github.com/k2b-dev/cloud/commit/f63fc3fcb10cd45b546437ac89a41e7f0effcba1))
* **ai:** stop learning from archived chats ([#743](https://github.com/k2b-dev/cloud/issues/743)) ([28e8ba1](https://github.com/k2b-dev/cloud/commit/28e8ba134d1a8795c9fab2a0e1cf32cca43f543b))
* **assistant:** keep CLI replies readable and chat titles as given ([#761](https://github.com/k2b-dev/cloud/issues/761)) ([c20e88c](https://github.com/k2b-dev/cloud/commit/c20e88c9e4ffe0dc9de60a3e45301a518913c58e))
* **gateway:** keep proxied requests on the app's own origin ([#777](https://github.com/k2b-dev/cloud/issues/777)) ([01ab1b4](https://github.com/k2b-dev/cloud/commit/01ab1b463db5f86e31e0571ddc5033b9e7e083e0))
* **mail:** stop stale statistics from slowing incoming automation backfills ([#742](https://github.com/k2b-dev/cloud/issues/742)) ([9c8e839](https://github.com/k2b-dev/cloud/commit/9c8e8392517eee1664aa142f002cd70539ca0ceb))
* **spaces:** load video tiles only in the browser so WebKit pages cannot freeze ([#781](https://github.com/k2b-dev/cloud/issues/781)) ([53d6b41](https://github.com/k2b-dev/cloud/commit/53d6b412f2bc5c86cd57d81461a39ab6597cc92f))
* **ui:** keep PdfPreview loading until the PDF has loaded and explain a missing viewer ([#767](https://github.com/k2b-dev/cloud/issues/767)) ([938dbb1](https://github.com/k2b-dev/cloud/commit/938dbb14c1979e6349feeb3c0fe1f67f56979fd8))
* **ui:** make a renewed VideoPlayer address continue where it stopped in WebKit ([#768](https://github.com/k2b-dev/cloud/issues/768)) ([be7b95c](https://github.com/k2b-dev/cloud/commit/be7b95ce52dd64600700207af4f37d706e5b2a37))

## [0.34.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.33.0...cloud-v0.34.0) (2026-10-08)


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
* **filesv2:** play videos in Files and attach them in Spaces ([#714](https://github.com/k2b-dev/cloud/issues/714)) ([6cd619d](https://github.com/k2b-dev/cloud/commit/6cd619dd4fa1a17a1b3d6e8ad7d12024f38cb610))
* **notebooks:** let writers order notes by hand ([#731](https://github.com/k2b-dev/cloud/issues/731)) ([0835dee](https://github.com/k2b-dev/cloud/commit/0835dee1ebedd72323089d1156abf62b98245f5e))
* **notebooks:** list the homepage note in the tree with a home icon ([#726](https://github.com/k2b-dev/cloud/issues/726)) ([304d103](https://github.com/k2b-dev/cloud/commit/304d1031d681735c88286bc8e95f0623397ec86a))
* **notifications:** deliver email through the default sender profile ([#725](https://github.com/k2b-dev/cloud/issues/725)) ([ab9f999](https://github.com/k2b-dev/cloud/commit/ab9f999aad1437b42ce685fe41a37bcde54ccf04))
* **ui:** calm reference pills and quiet links in every Markdown view ([#733](https://github.com/k2b-dev/cloud/issues/733)) ([4b00e92](https://github.com/k2b-dev/cloud/commit/4b00e92e52a9a54e28b4020732e96fe830d46be9))
* **ui:** drop files anywhere on the page, not into a thin strip ([#718](https://github.com/k2b-dev/cloud/issues/718)) ([732e64a](https://github.com/k2b-dev/cloud/commit/732e64a49cacf2fcd2608200a18da6815cba2a75))


### Bug Fixes

* **core:** keep Core boot migrations from failing when replicas race on a new schema ([#732](https://github.com/k2b-dev/cloud/issues/732)) ([6c07b51](https://github.com/k2b-dev/cloud/commit/6c07b516fbdb9008f63baed4588c7831943e568b))
* **mail:** give read-only users the mailbox details in the compose slot ([#728](https://github.com/k2b-dev/cloud/issues/728)) ([652c90f](https://github.com/k2b-dev/cloud/commit/652c90ff84fdd686b37064f5932d9c6218cdc408))
* **spaces:** confirm saved blockers and say how many people a task really has ([#736](https://github.com/k2b-dev/cloud/issues/736)) ([c481d05](https://github.com/k2b-dev/cloud/commit/c481d05e2143629b0e46c3693c1358a57b4a564f))
* **ui:** give table lines and hover highlights one consistent width ([#722](https://github.com/k2b-dev/cloud/issues/722)) ([e9bd63e](https://github.com/k2b-dev/cloud/commit/e9bd63e84a6208cdca8e2f0b947a720823da142e))
* **ui:** make the VideoPlayer playback tests reach the end reliably in WebKit ([#724](https://github.com/k2b-dev/cloud/issues/724)) ([be41bb8](https://github.com/k2b-dev/cloud/commit/be41bb81d87af0e29e9199cbd0f942897ee35021))

## [0.33.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.32.0...cloud-v0.33.0) (2026-10-07)


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

## [0.32.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.31.0...cloud-v0.32.0) (2026-10-07)


### ⚠ BREAKING CHANGES

* **ai:** fold finished work into one summary line ([#692](https://github.com/k2b-dev/cloud/issues/692))

### Features

* **access:** show who a group grant actually reaches in the access editor ([#697](https://github.com/k2b-dev/cloud/issues/697)) ([4d0e8b1](https://github.com/k2b-dev/cloud/commit/4d0e8b1a84e67ba5f103881edea9d6bf35682ff3)), closes [#688](https://github.com/k2b-dev/cloud/issues/688)
* **ai:** fold finished work into one summary line ([#692](https://github.com/k2b-dev/cloud/issues/692)) ([b4cd708](https://github.com/k2b-dev/cloud/commit/b4cd708d85581db60c51ebd7a863ea77c32cefca))
* **ai:** retry transient model provider errors ([#687](https://github.com/k2b-dev/cloud/issues/687)) ([5228701](https://github.com/k2b-dev/cloud/commit/5228701e5affb38fe22e6a166dc973ba244c3a48))
* **cli:** explain how the Assistant works for agents that configure it ([#696](https://github.com/k2b-dev/cloud/issues/696)) ([da06fed](https://github.com/k2b-dev/cloud/commit/da06fedee211ecbed2b8ab065747a43039a54747))
* **ui:** add a classless base stylesheet for HTML apps ([#695](https://github.com/k2b-dev/cloud/issues/695)) ([8a83654](https://github.com/k2b-dev/cloud/commit/8a83654754e200e85f624ffb104a756b21b36bcd))
* **venue:** plan one-off shifts and name opening-hour exceptions clearly ([#690](https://github.com/k2b-dev/cloud/issues/690)) ([5208134](https://github.com/k2b-dev/cloud/commit/5208134d48087e29af56d9a19756f50c5067d60c))


### Bug Fixes

* **ai:** show capabilities and approvals in the reader's language ([#682](https://github.com/k2b-dev/cloud/issues/682)) ([2c70089](https://github.com/k2b-dev/cloud/commit/2c700894d34f4b0ef5608931433f41a749dc9a10))
* **mail:** open every clicked conversation instead of freezing after the first switch ([#694](https://github.com/k2b-dev/cloud/issues/694)) ([a2d9f83](https://github.com/k2b-dev/cloud/commit/a2d9f8370af8160c3ed95083655bfb85c07b9627))

## [0.31.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.30.0...cloud-v0.31.0) (2026-10-06)


### Features

* **access:** keep at least one manager and show people by name in Grids access ([#677](https://github.com/k2b-dev/cloud/issues/677)) ([6a4aa5c](https://github.com/k2b-dev/cloud/commit/6a4aa5ca207341363af43438269e6bdd04f37b76))
* **browser:** attach files from Cloud apps through one source chooser ([#672](https://github.com/k2b-dev/cloud/issues/672)) ([be21047](https://github.com/k2b-dev/cloud/commit/be21047cabbe011445242a62636fac25fcb3b33f))
* **ui:** add a virtualized message list that keeps the reading position ([#668](https://github.com/k2b-dev/cloud/issues/668)) ([67b39a4](https://github.com/k2b-dev/cloud/commit/67b39a4b85f8f218984b71ba328e1da8ca499666))
* **ui:** add message rows for conversations with many people ([#676](https://github.com/k2b-dev/cloud/issues/676)) ([0598121](https://github.com/k2b-dev/cloud/commit/059812142bfb38e60ac10aa981cf69a0b949304b))
* **ui:** keep the QR camera running and say why it cannot start ([#675](https://github.com/k2b-dev/cloud/issues/675)) ([8861ae7](https://github.com/k2b-dev/cloud/commit/8861ae7a562b70898b05fead34f530630fbd78b2))
* **ui:** send Samsung Internet to Chrome to install apps on Android ([#674](https://github.com/k2b-dev/cloud/issues/674)) ([c23e072](https://github.com/k2b-dev/cloud/commit/c23e07260d64160845c01b5d5a7f79586d083dc2))
* **ui:** show quotes, reactions, threads and rich content in message rows ([#680](https://github.com/k2b-dev/cloud/issues/680)) ([626a12c](https://github.com/k2b-dev/cloud/commit/626a12c6ff9abce21707fa305a6735e752678ccf))


### Bug Fixes

* **access:** show agent managers in every access editor so people are not locked by mistake ([#679](https://github.com/k2b-dev/cloud/issues/679)) ([b06e391](https://github.com/k2b-dev/cloud/commit/b06e391d316bb0839ddd6fdc9c95c32ad95c4a42))
* **i18n:** name the admin area Administration in German ([#670](https://github.com/k2b-dev/cloud/issues/670)) ([31d3f56](https://github.com/k2b-dev/cloud/commit/31d3f569b3a8928250a1476e3d3e060ab81c67a6))
* **ui:** keep VirtualFeed's place through flings, resizes and keyboard scrolling ([#678](https://github.com/k2b-dev/cloud/issues/678)) ([147a2e0](https://github.com/k2b-dev/cloud/commit/147a2e011c95e859fe883de5cf6bf53449e612cf))

## [0.30.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.29.0...cloud-v0.30.0) (2026-10-06)


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
* **core:** sign-in actions read in the order they are shown ([#660](https://github.com/k2b-dev/cloud/issues/660)) ([4b3bf97](https://github.com/k2b-dev/cloud/commit/4b3bf9727a0ca3bf00156a80db04cae3a567f65c))
* **filesv2:** create new office documents on A4 paper ([#661](https://github.com/k2b-dev/cloud/issues/661)) ([6189217](https://github.com/k2b-dev/cloud/commit/6189217dec966080d32bd135872b14c0fb4d53f3))
* **filesv2:** open Collabora in the Cloud language ([#659](https://github.com/k2b-dev/cloud/issues/659)) ([75bfe28](https://github.com/k2b-dev/cloud/commit/75bfe2816bc8ae8a92a9d540989472b74fb5c042))
* **live:** resync returning subscriptions after access changes they missed ([#666](https://github.com/k2b-dev/cloud/issues/666)) ([7850a18](https://github.com/k2b-dev/cloud/commit/7850a183a1a374bde9e8a48b66b4bbe1a3aa6316))
* **mail:** answer searches in large mailboxes within the time limit ([#646](https://github.com/k2b-dev/cloud/issues/646)) ([8c38d37](https://github.com/k2b-dev/cloud/commit/8c38d37034f853980ba0ac20b43e1b2248a21a60))
* **mail:** hold scheduled sends while the mailbox needs a new login and tell the author ([#629](https://github.com/k2b-dev/cloud/issues/629)) ([62125be](https://github.com/k2b-dev/cloud/commit/62125be838964b09da4c225456b03ac398192b9b))
* **notebooks:** open note links that point to a heading ([#644](https://github.com/k2b-dev/cloud/issues/644)) ([222cebd](https://github.com/k2b-dev/cloud/commit/222cebdd61237324a30deb6946bb1bca1e647278))
* **notebooks:** stop late heading jumps and keep PDF note links inside the PDF ([#645](https://github.com/k2b-dev/cloud/issues/645)) ([0d879b0](https://github.com/k2b-dev/cloud/commit/0d879b0c9afcadc99696773502ae9585646d3202))
* **ui:** keep focus that moved before a dialog's first frame ([#665](https://github.com/k2b-dev/cloud/issues/665)) ([2573f5c](https://github.com/k2b-dev/cloud/commit/2573f5cec1019a2e146c458f4dfc85a64b96443a))

## [0.29.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.28.0...cloud-v0.29.0) (2026-10-05)


### Features

* **accounts:** let administrators see and remove app devices ([#614](https://github.com/k2b-dev/cloud/issues/614)) ([9ba1a35](https://github.com/k2b-dev/cloud/commit/9ba1a357d8344d52daf75ca1c52992feccf9f6d7))
* **cloud:** keep live updates quiet when a background tab returns ([#570](https://github.com/k2b-dev/cloud/issues/570)) ([#583](https://github.com/k2b-dev/cloud/issues/583)) ([b075650](https://github.com/k2b-dev/cloud/commit/b0756506e8b42d13e0d50b6138ddf8d2d772d56c))
* **cloud:** let applications add pages to the mobile app ([#609](https://github.com/k2b-dev/cloud/issues/609)) ([bd64ddb](https://github.com/k2b-dev/cloud/commit/bd64ddb620b4597df336b4410019d4392e819461))
* **cloud:** pair phones with long-lived app sessions ([#602](https://github.com/k2b-dev/cloud/issues/602)) ([cdea338](https://github.com/k2b-dev/cloud/commit/cdea3389f00c73d247ab431f919ccb2a19fbdb83))
* **core:** flatten the account pages ([#572](https://github.com/k2b-dev/cloud/issues/572)) ([deaf537](https://github.com/k2b-dev/cloud/commit/deaf537c25414d89785ef24407b839d880c49252))
* **core:** pair a phone in a dialog on a calmer App page ([#628](https://github.com/k2b-dev/cloud/issues/628)) ([97f0e63](https://github.com/k2b-dev/cloud/commit/97f0e6341ecfd66ad51cb8bb1d08be540a6665b7))
* **events:** write live updates in the domain transaction through one platform outbox ([#599](https://github.com/k2b-dev/cloud/issues/599)) ([864f459](https://github.com/k2b-dev/cloud/commit/864f459465f7c39a0af21b053fa7a6504af987c2))
* **gateway:** pass the real client address behind a reverse proxy so rate limits apply per client ([#617](https://github.com/k2b-dev/cloud/issues/617)) ([ba1f92b](https://github.com/k2b-dev/cloud/commit/ba1f92b333a48ccd19078db39fd232626a9b911a))
* **grids:** confirm only what the screen does not show, and offer Retry when an action fails ([#580](https://github.com/k2b-dev/cloud/issues/580)) ([1d5a42a](https://github.com/k2b-dev/cloud/commit/1d5a42a06e334e0895c1a828bcb9cda85903709a))
* keep rejected notes in their composer in Contacts and Notebooks, and report failed clicks in a toast ([#582](https://github.com/k2b-dev/cloud/issues/582)) ([bf252b1](https://github.com/k2b-dev/cloud/commit/bf252b1f5b27c21c4f47c62567b426c24f55eb7a))
* **live:** serve live channels over one socket per app and check access at delivery ([#610](https://github.com/k2b-dev/cloud/issues/610)) ([2a77a14](https://github.com/k2b-dev/cloud/commit/2a77a14583f407e02887497b50e755eb60ededab))
* **mail:** apply message actions only to the chosen messages and undo failed changes correctly ([#594](https://github.com/k2b-dev/cloud/issues/594)) ([b8727a9](https://github.com/k2b-dev/cloud/commit/b8727a9f1593df6eb2c5f8aa4db49109bf3286a7))
* **mail:** confirm only what the screen does not show, and offer Retry when an action fails ([#578](https://github.com/k2b-dev/cloud/issues/578)) ([c455391](https://github.com/k2b-dev/cloud/commit/c45539126e0e663cfdb4260379a98293ed98ae6d))
* **mail:** keep mails of a folder inside that folder when asked ([#619](https://github.com/k2b-dev/cloud/issues/619)) ([ab5d9dc](https://github.com/k2b-dev/cloud/commit/ab5d9dc1980ff536cb5a070a1dfef8ce3ca79a34))
* **mail:** keep pinned and hidden mailboxes per person or agent on every device ([#579](https://github.com/k2b-dev/cloud/issues/579)) ([16b8e7d](https://github.com/k2b-dev/cloud/commit/16b8e7d8cef0c99e1358e53ffbe058b9804400c1))
* **mail:** make sync --wait wait until its folders have synced ([#571](https://github.com/k2b-dev/cloud/issues/571)) ([2a106ee](https://github.com/k2b-dev/cloud/commit/2a106ee3394a01b178e341559d33a886701e9339))
* **mail:** show folder settings as a compact tree ([#623](https://github.com/k2b-dev/cloud/issues/623)) ([8dd56f9](https://github.com/k2b-dev/cloud/commit/8dd56f983bee8b9bd494f5a13fd1f78d3a53decf))
* **notebooks:** let admins reserve locking notes along with deleting them ([#575](https://github.com/k2b-dev/cloud/issues/575)) ([5a4e929](https://github.com/k2b-dev/cloud/commit/5a4e9299d41326154e9270f78eaaea9086799333))
* **notebooks:** preview attached files instead of only downloading them ([#574](https://github.com/k2b-dev/cloud/issues/574)) ([8c443eb](https://github.com/k2b-dev/cloud/commit/8c443eb73cde98ff26c98035d0ab15d7fc9f80c1))
* **pwa:** add the installable mobile app ([#605](https://github.com/k2b-dev/cloud/issues/605)) ([27e42cc](https://github.com/k2b-dev/cloud/commit/27e42cc1eccaf4b1943645fcb7cf34855507bc22))
* **pwa:** calm app shell without lines and warn when the install page is not open in Safari ([#626](https://github.com/k2b-dev/cloud/issues/626)) ([4a64cc8](https://github.com/k2b-dev/cloud/commit/4a64cc874e7e10e180b5b90d0ccf58fc24af6abd))
* **spaces:** check off my tasks in the mobile app ([#611](https://github.com/k2b-dev/cloud/issues/611)) ([227ddfc](https://github.com/k2b-dev/cloud/commit/227ddfccb271b37c046a8e2b6eb2666eb4ffc94e))
* **spaces:** confirm only what the screen does not show, and offer Retry when an action fails ([#577](https://github.com/k2b-dev/cloud/issues/577)) ([4643b0a](https://github.com/k2b-dev/cloud/commit/4643b0a85882fb2b453827b58942573fe80f66ae))
* **ui:** announce action outcomes to screen readers in every app ([#616](https://github.com/k2b-dev/cloud/issues/616)) ([e19e7ac](https://github.com/k2b-dev/cloud/commit/e19e7ac8b67ab7bfb0c5433a97cce68197f01485))
* **ui:** share phone app building blocks with Cloud Login ([#591](https://github.com/k2b-dev/cloud/issues/591)) ([394af22](https://github.com/k2b-dev/cloud/commit/394af22d4053b7418481ee25beda9288b88d038b))


### Bug Fixes

* **ai:** stop the turn stream when access ends and report errors instead of retrying forever ([#606](https://github.com/k2b-dev/cloud/issues/606)) ([b6f6fb5](https://github.com/k2b-dev/cloud/commit/b6f6fb57ea3974e3ef4d0df0b910b4b63789202e))
* announce quiet confirmations in Spaces, confirm hidden completions with Undo, and keep create and edit dialogs open until saved ([#585](https://github.com/k2b-dev/cloud/issues/585)) ([0a40a67](https://github.com/k2b-dev/cloud/commit/0a40a675282a976597c0a6f5d406cecb3e5d45aa))
* **events:** keep live updates flowing under load and behind one busy key ([#620](https://github.com/k2b-dev/cloud/issues/620)) ([a6a15bf](https://github.com/k2b-dev/cloud/commit/a6a15bf3e7ac37ffc514b63768c94fa53ef9d034))
* **files:** keep trash and archive recovery working with Filegate 7 ([#627](https://github.com/k2b-dev/cloud/issues/627)) ([2bebab7](https://github.com/k2b-dev/cloud/commit/2bebab7d698ee572f2195ee33e812372704f95e1))
* give every detail panel section the same flat frame, comments included ([#592](https://github.com/k2b-dev/cloud/issues/592)) ([42e81a6](https://github.com/k2b-dev/cloud/commit/42e81a6a6d9ff36d01fda71b73ac23b5a423795c))
* **grids:** create each workflow email delivery once when two runs race ([#615](https://github.com/k2b-dev/cloud/issues/615)) ([11b35d6](https://github.com/k2b-dev/cloud/commit/11b35d63b00aaa5fc7783c1f500256ec497791d6))
* **grids:** deliver records, structure and workflow runs over one live socket ([#636](https://github.com/k2b-dev/cloud/issues/636)) ([88034a2](https://github.com/k2b-dev/cloud/commit/88034a29df459860e1df4375a21b5b90cc2bc28f))
* **grids:** never skip committed records in the change feed ([#612](https://github.com/k2b-dev/cloud/issues/612)) ([99a9778](https://github.com/k2b-dev/cloud/commit/99a97786b55cf78176063b45bb9b8a9c00f320a6))
* **grids:** offer to publish a Custom App again after a Form or other used resource changed ([#593](https://github.com/k2b-dev/cloud/issues/593)) ([8840635](https://github.com/k2b-dev/cloud/commit/88406358c73d9c97c136e3fdf8a3531d6beb9ade)), closes [#539](https://github.com/k2b-dev/cloud/issues/539)
* **grids:** tell App readers who can bring back a changed Form ([#596](https://github.com/k2b-dev/cloud/issues/596)) ([daf6d7a](https://github.com/k2b-dev/cloud/commit/daf6d7a4b5986a8da6bfa792e1473e6c573643be))
* **live:** stop live engine timers before Sync shuts down ([#637](https://github.com/k2b-dev/cloud/issues/637)) ([390c15a](https://github.com/k2b-dev/cloud/commit/390c15ae92a781a21f82d94ee018fd2a2dc07a44))
* **mail:** finish every send reliably and run commands queued with personal API keys ([#573](https://github.com/k2b-dev/cloud/issues/573)) ([9232582](https://github.com/k2b-dev/cloud/commit/92325823486d9190c981f78457e5b9b655457001))
* **mail:** keep a Sent copy for messages that reached only some recipients ([#635](https://github.com/k2b-dev/cloud/issues/635)) ([d458e4b](https://github.com/k2b-dev/cloud/commit/d458e4bdb7218835ea384a3c38fa07d358f7b481))
* **mail:** keep drafts correct across Mail, the Drafts folder and other mail programs ([#604](https://github.com/k2b-dev/cloud/issues/604)) ([c11a596](https://github.com/k2b-dev/cloud/commit/c11a596955544e7a1582124377ad230289a344d0))
* **mail:** keep folders and message bodies syncing through restarts and provider outages ([#587](https://github.com/k2b-dev/cloud/issues/587)) ([4c1bd2a](https://github.com/k2b-dev/cloud/commit/4c1bd2a56ddb83dda93bad0071d8021306a488d6))
* **mail:** keep healthy mailboxes syncing while one provider host is down ([#618](https://github.com/k2b-dev/cloud/issues/618)) ([fe9eaf5](https://github.com/k2b-dev/cloud/commit/fe9eaf51e8d2d36f7abb6084754d8407f616cc26))
* **mail:** keep mailboxes syncing when a provider refuses connections at its limit ([#590](https://github.com/k2b-dev/cloud/issues/590)) ([3a2c0dc](https://github.com/k2b-dev/cloud/commit/3a2c0dcfd76e529a366b50a67cf07a9b2401e5de))
* **mail:** list recently deleted mailboxes again ([#588](https://github.com/k2b-dev/cloud/issues/588)) ([64e890b](https://github.com/k2b-dev/cloud/commit/64e890b6a488db58e440c1fa32128a934af1b8ae))
* **mail:** load the Mail workspace view counts quickly in large mailboxes ([#613](https://github.com/k2b-dev/cloud/issues/613)) ([fa3cc76](https://github.com/k2b-dev/cloud/commit/fa3cc769d855350a64c9af6dd5015bc5de1ff9d0))
* **mail:** project finished draft attachments and export drafts that change mid-append ([#625](https://github.com/k2b-dev/cloud/issues/625)) ([85d1757](https://github.com/k2b-dev/cloud/commit/85d1757b90b96d17297b2492b177fe94f0b6ce18))
* **mail:** report a Send problems row in no folder instead of calling it already moved ([#600](https://github.com/k2b-dev/cloud/issues/600)) ([abe0421](https://github.com/k2b-dev/cloud/commit/abe042143573a7da1100856762ed6a1b3cf80331))
* **mail:** return full search pages and correct unread and Send problems in message mode ([#598](https://github.com/k2b-dev/cloud/issues/598)) ([e2efea7](https://github.com/k2b-dev/cloud/commit/e2efea7651c258ddd2b6b140433c73a356e2eeb7))
* **mail:** run queued mailbox commands in the order the mailbox lock accepted them ([#621](https://github.com/k2b-dev/cloud/issues/621)) ([9a779fe](https://github.com/k2b-dev/cloud/commit/9a779feb8789169faaf6ad146060facc8dfde217))
* **mail:** share one live connection per tab for the mailbox, composer and dialogs ([#630](https://github.com/k2b-dev/cloud/issues/630)) ([da155cf](https://github.com/k2b-dev/cloud/commit/da155cf1d00cc564c343bc24a59540ff95b69bf3))
* match the Files preview in Mail, Grids and Assistant previews ([#568](https://github.com/k2b-dev/cloud/issues/568)) ([47c34ef](https://github.com/k2b-dev/cloud/commit/47c34efc975255a6e0d2bd025ae7769c11894e0d))
* **notebooks:** keep live updates for long notes by sending only references ([#608](https://github.com/k2b-dev/cloud/issues/608)) ([c16cf0c](https://github.com/k2b-dev/cloud/commit/c16cf0c37745b5cfab0de57366d510d7b7d4d09e))
* **oauth:** let people approve app access in the browser again ([#638](https://github.com/k2b-dev/cloud/issues/638)) ([9b8001d](https://github.com/k2b-dev/cloud/commit/9b8001de33cd2b7fdd7c00348d2d8b6c39909485))
* **pwa-auth:** keep icons the same width while the inlined icon font decodes ([#586](https://github.com/k2b-dev/cloud/issues/586)) ([04414a7](https://github.com/k2b-dev/cloud/commit/04414a7c6233e0dfa0d7909f54a4cc0a262058b5))
* **pwa:** open app pages on the first tap and check off tasks instantly ([#622](https://github.com/k2b-dev/cloud/issues/622)) ([0c063eb](https://github.com/k2b-dev/cloud/commit/0c063ebcd856cfd4991a2830d0fc940bd4cdf9ec))
* **spaces:** stop losing Space live updates by moving them onto the shared live layer ([#624](https://github.com/k2b-dev/cloud/issues/624)) ([3780886](https://github.com/k2b-dev/cloud/commit/3780886a9bcbda93bc5e7ff4a7a3fb29b239218b))
* **ui:** finish the flat-frame sweep in dialogs and keep Mail's detail layout ([#595](https://github.com/k2b-dev/cloud/issues/595)) ([ff405ea](https://github.com/k2b-dev/cloud/commit/ff405eacda76c76b3e81182568b0f6494f6a2a02))
* **ui:** keep icons the same width while the icon font loads ([#581](https://github.com/k2b-dev/cloud/issues/581)) ([cb58bbc](https://github.com/k2b-dev/cloud/commit/cb58bbc157f8f838c442d4c06036701358ff27f5))

## [0.28.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.27.0...cloud-v0.28.0) (2026-10-03)


### Features

* **files:** open previews with the document title and no second frame ([#563](https://github.com/k2b-dev/cloud/issues/563)) ([79864a1](https://github.com/k2b-dev/cloud/commit/79864a1d21e4e11db9ae22545ed09651588c9e5e))
* **files:** show every upload in one calm list with the total progress ([#533](https://github.com/k2b-dev/cloud/issues/533)) ([5100c3e](https://github.com/k2b-dev/cloud/commit/5100c3eb32c1d7fa98f13ef781aa1413c771ff4f))
* **grids:** show an empty table as one calm empty state with a way to add the first record ([#557](https://github.com/k2b-dev/cloud/issues/557)) ([17f4085](https://github.com/k2b-dev/cloud/commit/17f40859190dd5a83f576f99fecd54e387875a3f))
* **mail:** hide mailboxes from your sidebar and focus ([#566](https://github.com/k2b-dev/cloud/issues/566)) ([f6e1996](https://github.com/k2b-dev/cloud/commit/f6e199629e5ecec6bb596da2bfa4d11007f3ead9))
* **mail:** move many messages at once with one IMAP command ([#554](https://github.com/k2b-dev/cloud/issues/554)) ([a79d3bf](https://github.com/k2b-dev/cloud/commit/a79d3bf8e03299dadcc01965521b338896860503))
* **notebooks:** let admins reserve deleting notes for themselves ([#552](https://github.com/k2b-dev/cloud/issues/552)) ([53c89c1](https://github.com/k2b-dev/cloud/commit/53c89c153079fb43b99b382916b8897558619fe2))
* show attachment and artifact previews the same calm way as Files ([#565](https://github.com/k2b-dev/cloud/issues/565)) ([4352fe5](https://github.com/k2b-dev/cloud/commit/4352fe548a23cf7b64c81932a031a35287a15ee1))
* **spaces:** show blockers, properties and who is working at a glance ([#551](https://github.com/k2b-dev/cloud/issues/551)) ([7348cf8](https://github.com/k2b-dev/cloud/commit/7348cf8d8088e16f5a5d20d56c2b2fb7635110b6))
* **ui:** calmer Markdown tables, quotes and code ([#561](https://github.com/k2b-dev/cloud/issues/561)) ([666ebae](https://github.com/k2b-dev/cloud/commit/666ebae2669bcc2054ed964dab64231464ab54e5))
* **ui:** give every surface a single frame ([#541](https://github.com/k2b-dev/cloud/issues/541)) ([9d613ed](https://github.com/k2b-dev/cloud/commit/9d613edf6afd047fb0f56c95bf0e02d7ae691f59))
* **ui:** group dialog sections without frames ([#558](https://github.com/k2b-dev/cloud/issues/558)) ([e6ec679](https://github.com/k2b-dev/cloud/commit/e6ec67959355bbca8c296b1cd64d76714dc9a402))
* **ui:** show toasts as one calm line ([#536](https://github.com/k2b-dev/cloud/issues/536)) ([8b3b358](https://github.com/k2b-dev/cloud/commit/8b3b358ee3c627e5b58cd037d7cee3bbb8c5f692))


### Bug Fixes

* **mail:** act on the folder in view, report refused actions, and run automations on Gmail labels ([#547](https://github.com/k2b-dev/cloud/issues/547)) ([7ba01c7](https://github.com/k2b-dev/cloud/commit/7ba01c704a4a74ea7dd193db8bd95ab5d2bc289d))
* **mail:** keep a message's date and size when another copy of it syncs ([#560](https://github.com/k2b-dev/cloud/issues/560)) ([e6b6675](https://github.com/k2b-dev/cloud/commit/e6b6675e043ba9d6e48707075629bc0f05aae2fa))
* **mail:** keep finding removals that race a search and show recent flag changes at every sync without CONDSTORE ([#556](https://github.com/k2b-dev/cloud/issues/556)) ([7444566](https://github.com/k2b-dev/cloud/commit/744456688ab93528ecedb0a39421ef1b1636f633))
* **mail:** keep Gmail labels when archiving from views across folders ([#549](https://github.com/k2b-dev/cloud/issues/549)) ([02dc11e](https://github.com/k2b-dev/cloud/commit/02dc11ecba67ae38175118896fd5469db8e16ea8))
* **mail:** keep mail that arrived after Send in Needs action ([#564](https://github.com/k2b-dev/cloud/issues/564)) ([c5b0ffe](https://github.com/k2b-dev/cloud/commit/c5b0ffe459b8f544b685aeb15a5feefbe68741e7))
* **mail:** keep Needs action, Unassigned, counts and search results accurate ([#562](https://github.com/k2b-dev/cloud/issues/562)) ([82a06b3](https://github.com/k2b-dev/cloud/commit/82a06b302d39c47414f2c853815a837c4a2af758))
* **mail:** keep quoted text open across live updates and show it with a proper toggle ([#544](https://github.com/k2b-dev/cloud/issues/544)) ([19ca148](https://github.com/k2b-dev/cloud/commit/19ca1486eb32d220c8f6548888473a4142196cda))
* **mail:** let folder sync take its turn while commands and hydration run ([#548](https://github.com/k2b-dev/cloud/issues/548)) ([adc5e07](https://github.com/k2b-dev/cloud/commit/adc5e077122865246306932506bf897b42e5f157))
* **mail:** retry sends and actions after brief provider failures instead of dropping them ([#545](https://github.com/k2b-dev/cloud/issues/545)) ([d770035](https://github.com/k2b-dev/cloud/commit/d770035d196e0eaffc2b7b139df3f7082298b168))
* **mail:** show deletes, moves and flag changes from other apps within minutes and finish large Drafts reconciliations ([#553](https://github.com/k2b-dev/cloud/issues/553)) ([b00d16f](https://github.com/k2b-dev/cloud/commit/b00d16f721663e3b8af9112dd15637d058ea6609))
* **mail:** show sent messages in Sent right after sending and store the copy once ([#538](https://github.com/k2b-dev/cloud/issues/538)) ([92371af](https://github.com/k2b-dev/cloud/commit/92371af43370655faff99bfcd766e39cce141265))
* **mail:** treat moved and copied messages as one message and thread only related mail together ([#559](https://github.com/k2b-dev/cloud/issues/559)) ([90e0ae6](https://github.com/k2b-dev/cloud/commit/90e0ae6393355e9487e8eca2c9bdc4c5cb73065d))
* **pwa-auth:** give the status bar its color back after a dialog closes ([#542](https://github.com/k2b-dev/cloud/issues/542)) ([ce7fab8](https://github.com/k2b-dev/cloud/commit/ce7fab85741204aa5364a6a0d81dfa8880b37786))
* **spaces:** center the column drop indicator and show previews without Markdown syntax ([#546](https://github.com/k2b-dev/cloud/issues/546)) ([d2cb394](https://github.com/k2b-dev/cloud/commit/d2cb394ca92d0f782f81ede670d7beba85eaeefd))
* **ui:** keep dialog headers in view and apply the code and table styles meant for previews ([#532](https://github.com/k2b-dev/cloud/issues/532)) ([cc93131](https://github.com/k2b-dev/cloud/commit/cc931312f21e7b11d05528c1a418c8072bd0c35a))
* **ui:** keep toasts timing out after a held control leaves the page ([#555](https://github.com/k2b-dev/cloud/issues/555)) ([e191790](https://github.com/k2b-dev/cloud/commit/e191790f56a3c5a67313d5df19e70f8bc4c4c099))


### Performance Improvements

* **mail:** run each message action in one IMAP session ([#550](https://github.com/k2b-dev/cloud/issues/550)) ([9ff5ce5](https://github.com/k2b-dev/cloud/commit/9ff5ce507163e1887f6ff8195dea041f5472bdd1))

## [0.27.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.26.0...cloud-v0.27.0) (2026-10-01)


### Features

* **mail:** show a quick look card when hovering a conversation ([#517](https://github.com/k2b-dev/cloud/issues/517)) ([a8402c8](https://github.com/k2b-dev/cloud/commit/a8402c8ceac8d54960f13d9d1145542eee3e0a46))
* **notebooks:** hide the navigation completely for focused writing ([#520](https://github.com/k2b-dev/cloud/issues/520)) ([e78fd79](https://github.com/k2b-dev/cloud/commit/e78fd797e6d7e5a190fa3906bf4796a7308260a5))
* **spaces:** filter the kanban board and fold columns away ([#521](https://github.com/k2b-dev/cloud/issues/521)) ([1ba5d98](https://github.com/k2b-dev/cloud/commit/1ba5d9841cbc7ccd968c8c88064891406ac02ce0))
* **spaces:** show blocked and overdue tasks in their own kanban columns ([#524](https://github.com/k2b-dev/cloud/issues/524)) ([ba95fd1](https://github.com/k2b-dev/cloud/commit/ba95fd14e84cb1c9032f54368ef12eb5740c7740))


### Bug Fixes

* **notebooks:** hide Book view's contents list together with the navigation ([#523](https://github.com/k2b-dev/cloud/issues/523)) ([b735196](https://github.com/k2b-dev/cloud/commit/b735196fe11a379700a1745462bc62bbdb097ffc))
* **notebooks:** keep the text at the top of a note in place when the navigation hides or shows ([#525](https://github.com/k2b-dev/cloud/issues/525)) ([23c5957](https://github.com/k2b-dev/cloud/commit/23c59572a290a7bbc54e65f358285741c4913a00))
* open the notebook, space, or base you used last ([#519](https://github.com/k2b-dev/cloud/issues/519)) ([4f0d92c](https://github.com/k2b-dev/cloud/commit/4f0d92cbf80a6e6b36f2bcc9fb81888836d6fbbe))

## [0.26.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.25.0...cloud-v0.26.0) (2026-10-01)


### ⚠ BREAKING CHANGES

* **assistant:** the exported browser-safe type `AiChatQuotaSnapshot` and `GET /api/ai/quotas` (and `getAiChatQuotas()`) no longer carry money: `unit`, `limit`, `used`, `input`, `output`, and `estimated` are gone. Each balance is now `{ scope, unlimited, usedPercent, resetsAt }`. `usedPercent` is a whole number from 0 to 100, reaches 100 only when the allowance is used up, and is `null` when the allowance is unlimited or cannot be measured. Administrators still configure allowances in money in the admin settings, and the administrator endpoints keep amounts.

### Features

* **assistant:** show chat usage as a quiet ring without money ([#486](https://github.com/k2b-dev/cloud/issues/486)) ([27f6b77](https://github.com/k2b-dev/cloud/commit/27f6b7721c44d5328387c5cdfa99b1473f22a84a))
* **cloud:** show sign-in and other simple pages without a card on phones ([#481](https://github.com/k2b-dev/cloud/issues/481)) ([d6a805e](https://github.com/k2b-dev/cloud/commit/d6a805e462f968a1c472ef0289fee3d74f8c8a2c))
* **ui:** add a hover preview card that opens beside its anchor ([#516](https://github.com/k2b-dev/cloud/issues/516)) ([3a05dd3](https://github.com/k2b-dev/cloud/commit/3a05dd3ec8528766bcee25cd8f49f553b19b540a))
* **ui:** keep focus rings visible inside clipping containers ([#484](https://github.com/k2b-dev/cloud/issues/484)) ([b5051f9](https://github.com/k2b-dev/cloud/commit/b5051f99cd6238c12cd7f99aac1e25803a488b8a))


### Bug Fixes

* **cloud:** keep focus rings whole on flat standalone cards on phones ([#498](https://github.com/k2b-dev/cloud/issues/498)) ([ecd61ee](https://github.com/k2b-dev/cloud/commit/ecd61ee52cd56e0015949f7334b76128af449697))
* **cloud:** keep starting until NATS and JetStream answer instead of staying unhealthy ([#482](https://github.com/k2b-dev/cloud/issues/482)) ([d3c8cdc](https://github.com/k2b-dev/cloud/commit/d3c8cdc61c4d1914756724cdfb91c3f40e7e1ec5))
* **cloud:** preload the Latin Plex faces so pages keep their first-frame layout ([#483](https://github.com/k2b-dev/cloud/issues/483)) ([82bbf3f](https://github.com/k2b-dev/cloud/commit/82bbf3fa65bcc00178b400f2f28ebba5b5e28823))
* **cloud:** show each service account's kind the same way in access editors, pickers, and cost limits ([#488](https://github.com/k2b-dev/cloud/issues/488)) ([89f9db9](https://github.com/k2b-dev/cloud/commit/89f9db99f7091d9b1001e27d24197538308f3cc4))
* keep phone footers on finger-sized targets with a compact language and theme control ([#510](https://github.com/k2b-dev/cloud/issues/510)) ([2a2f564](https://github.com/k2b-dev/cloud/commit/2a2f564fd3ae0bfc5f0f928ec3bcf36dbcd23a4f))
* let agent and standalone service accounts use their grants in Pulse and Venue ([#494](https://github.com/k2b-dev/cloud/issues/494)) ([3b7480c](https://github.com/k2b-dev/cloud/commit/3b7480c779368c3e6b6198c83ee6db2c958c3027))
* **mail:** cap agent and standalone tokens by their scopes like every other app ([#492](https://github.com/k2b-dev/cloud/issues/492)) ([b37aad8](https://github.com/k2b-dev/cloud/commit/b37aad8d373644fefbc70d8a078ee37e3104e9c9))
* **mail:** keep a stuck IMAP connection from crashing the Mail process ([#507](https://github.com/k2b-dev/cloud/issues/507)) ([a987442](https://github.com/k2b-dev/cloud/commit/a987442f847c66a8062b1480bd1b81892e5772db))
* **mail:** keep IMAP push listeners through short lease-store stalls and record why a lease was lost ([#514](https://github.com/k2b-dev/cloud/issues/514)) ([65a3f5c](https://github.com/k2b-dev/cloud/commit/65a3f5c5fb8e04126aaa15cfef4995b23dbd5aea))
* **mail:** keep one unstorable envelope value from stalling a folder's sync ([#515](https://github.com/k2b-dev/cloud/issues/515)) ([ffed951](https://github.com/k2b-dev/cloud/commit/ffed951381d5ddb4f26083297c10d0887462eb58))
* **mail:** move to imapflow 2 and sync messages with an unreadable Date header ([#502](https://github.com/k2b-dev/cloud/issues/502)) ([2e400f1](https://github.com/k2b-dev/cloud/commit/2e400f196e5ab0052ae5f205dddde54a80abc89f)), closes [#464](https://github.com/k2b-dev/cloud/issues/464)
* **notebooks:** keep the line you type above the editor's bottom fade ([#499](https://github.com/k2b-dev/cloud/issues/499)) ([0ae8d3c](https://github.com/k2b-dev/cloud/commit/0ae8d3c78825d4a3b64c8eb2d92c9b6d9e373875))
* **notebooks:** list the home note first in the book sidebar ([#478](https://github.com/k2b-dev/cloud/issues/478)) ([93f10a9](https://github.com/k2b-dev/cloud/commit/93f10a980240b582c4f37b6d03341e2c6bccd02d))
* **ui:** give icon-only controls a tooltip with their label ([#497](https://github.com/k2b-dev/cloud/issues/497)) ([f3119bc](https://github.com/k2b-dev/cloud/commit/f3119bc687158c0209699273e77798ab08b53664))
* **ui:** keep a just-opened context menu open ([#512](https://github.com/k2b-dev/cloud/issues/512)) ([591c840](https://github.com/k2b-dev/cloud/commit/591c8409414a9a14df0fd224d4fb28db97a3086e))
* **ui:** keep field errors red inside dialog sections ([#501](https://github.com/k2b-dev/cloud/issues/501)) ([6ee0b0a](https://github.com/k2b-dev/cloud/commit/6ee0b0a8d6494797b375e397bc2069fed82bf2ec))
* **ui:** keep multi-line fields with a description inside form dialogs ([#508](https://github.com/k2b-dev/cloud/issues/508)) ([ef6738f](https://github.com/k2b-dev/cloud/commit/ef6738f4e1678bb5cee9a3b8022797c3f1c129e6))
* **ui:** keep the tab list from scrolling vertically ([#500](https://github.com/k2b-dev/cloud/issues/500)) ([fac3137](https://github.com/k2b-dev/cloud/commit/fac3137141f37871555de2381ec4349f1708f0cf))
* **ui:** return focus without a ring when a pointer opened the overlay ([#496](https://github.com/k2b-dev/cloud/issues/496)) ([5be160b](https://github.com/k2b-dev/cloud/commit/5be160bbc2e62078b0da6bb6ac181d2677c1c7bc))
* **ui:** reveal the sidebar preview button without shrinking the item label ([#511](https://github.com/k2b-dev/cloud/issues/511)) ([8f0ffa5](https://github.com/k2b-dev/cloud/commit/8f0ffa5a6463705d13bf9328e9f9545426ee4f08))
* **ui:** show the loading placeholder while a PDF preview loads ([#506](https://github.com/k2b-dev/cloud/issues/506)) ([b94acfd](https://github.com/k2b-dev/cloud/commit/b94acfdbab3b16bf78c9a2be23484996bd55bd05))
* **ui:** size menus to their content so every label is readable ([#503](https://github.com/k2b-dev/cloud/issues/503)) ([2f38dae](https://github.com/k2b-dev/cloud/commit/2f38daed413d962715fe754be8cf8ebd92709b30))

## [0.25.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.24.0...cloud-v0.25.0) (2026-09-30)


### ⚠ BREAKING CHANGES

* **files:** remove the legacy Files app ([#465](https://github.com/k2b-dev/cloud/issues/465))

### Features

* **cloud:** document the real validation error in every OpenAPI route ([#459](https://github.com/k2b-dev/cloud/issues/459)) ([d2a080d](https://github.com/k2b-dev/cloud/commit/d2a080db520577bad87bf77a375fa25cd489058e))
* **cloud:** end public minimal pages with legal links and labeled language and theme settings ([#446](https://github.com/k2b-dev/cloud/issues/446)) ([163cc8f](https://github.com/k2b-dev/cloud/commit/163cc8fd9e64228eb385f2088f40ac50af2f63f2))
* **cloud:** move to @k2b/sync 7 and bound dead-letter storage for topics ([#467](https://github.com/k2b-dev/cloud/issues/467)) ([e4c2397](https://github.com/k2b-dev/cloud/commit/e4c2397897e3eac6dfd81afabeae98b4319d399b))
* **cloud:** reserve small JetStream budgets for Sync jobs and queues by default ([#449](https://github.com/k2b-dev/cloud/issues/449)) ([8304632](https://github.com/k2b-dev/cloud/commit/830463293e3361b808d3daab6bf5f4b6db30938f)), closes [#362](https://github.com/k2b-dev/cloud/issues/362)
* **cloud:** set the Gotenberg URL from GOTENBERG_URL ([#456](https://github.com/k2b-dev/cloud/issues/456)) ([e49fadc](https://github.com/k2b-dev/cloud/commit/e49fadcbbb27fb7d00058f12678ce0f79843d7c6))
* **core:** offer the password first when signing in with a FreeIPA account ([#471](https://github.com/k2b-dev/cloud/issues/471)) ([c5ffd3b](https://github.com/k2b-dev/cloud/commit/c5ffd3bdb3409be0d998505245324a0f2b9f509d))
* **files:** ask whether to include hidden system files when uploading folders ([#441](https://github.com/k2b-dev/cloud/issues/441)) ([88b4a9c](https://github.com/k2b-dev/cloud/commit/88b4a9c0d4547ce26f96978a0af54fe99b0b14ca))
* **files:** remove the legacy Files app ([#465](https://github.com/k2b-dev/cloud/issues/465)) ([f6a6a2f](https://github.com/k2b-dev/cloud/commit/f6a6a2fb41337044611e83d7b0de478d56159de3))
* **notebooks:** render info boxes and other note blocks in PDF exports ([#444](https://github.com/k2b-dev/cloud/issues/444)) ([2602a44](https://github.com/k2b-dev/cloud/commit/2602a44b4ad437718a746b208113e980af191eb9))


### Bug Fixes

* **cloud:** form ligatures in report PDFs ([#452](https://github.com/k2b-dev/cloud/issues/452)) ([d88e867](https://github.com/k2b-dev/cloud/commit/d88e867a30fe92a002e2adb5b506c4ec956a5019))
* **cloud:** pick the first supported language from the browser ([#450](https://github.com/k2b-dev/cloud/issues/450)) ([51a18da](https://github.com/k2b-dev/cloud/commit/51a18da275968482d7968500731035e85459b9a2))
* **cloud:** stop app pages from coming back stale from the browser cache ([#442](https://github.com/k2b-dev/cloud/issues/442)) ([5669879](https://github.com/k2b-dev/cloud/commit/566987982580284f1a56d966287861e7ebe7d74f))
* **deps:** move to @k2b/stdlib 0.27.0 and show dates in each locale's order ([#472](https://github.com/k2b-dev/cloud/issues/472)) ([163ace1](https://github.com/k2b-dev/cloud/commit/163ace136dd89d587a700d579df9a42502d71f60))
* **deps:** move to marked 18 ([#474](https://github.com/k2b-dev/cloud/issues/474)) ([5dd1d3a](https://github.com/k2b-dev/cloud/commit/5dd1d3aca52b03744fc0059fc5619a32e9972143)), closes [#463](https://github.com/k2b-dev/cloud/issues/463)
* **deps:** resolve undici past GHSA-rfgv-xxqx-mfg5 and GHSA-w293-vg96-wgc3 ([#470](https://github.com/k2b-dev/cloud/issues/470)) ([be76413](https://github.com/k2b-dev/cloud/commit/be76413df84f9cf388710f159ea73a5ca8d95807))
* **files:** handle dot-files Safari leaves out of folder uploads and drops ([#458](https://github.com/k2b-dev/cloud/issues/458)) ([a4bcea8](https://github.com/k2b-dev/cloud/commit/a4bcea89e951327d1951c22952d24471baf7ce73))
* **grids:** drop the gradient that ended above the public document page footer ([#453](https://github.com/k2b-dev/cloud/issues/453)) ([7fb18b9](https://github.com/k2b-dev/cloud/commit/7fb18b9f4f6dd982dd1a3f5230b4acf4eeaeea4c))
* **notebooks:** print ligature arrows and symbols cleanly in PDF exports ([#447](https://github.com/k2b-dev/cloud/issues/447)) ([ac916a9](https://github.com/k2b-dev/cloud/commit/ac916a96e731f12826cf465d78c97bd1520ac9a5))
* **notebooks:** render info boxes that follow a table of contents in the editor ([#455](https://github.com/k2b-dev/cloud/issues/455)) ([172584e](https://github.com/k2b-dev/cloud/commit/172584e1ed5c8850ab9880bb005226d49f3c8b73))
* **ui:** keep iPhones from zooming when a text field takes focus ([#477](https://github.com/k2b-dev/cloud/issues/477)) ([8b480ec](https://github.com/k2b-dev/cloud/commit/8b480ec6e27b51e4cf3c445cee2e23509f57d197))
* **ui:** keep the CheckboxCard input inside its card when lists scroll ([#445](https://github.com/k2b-dev/cloud/issues/445)) ([e466802](https://github.com/k2b-dev/cloud/commit/e466802ee642192ab5035f53c78c54b5d0f1c2ac)), closes [#404](https://github.com/k2b-dev/cloud/issues/404)
* **ui:** make dropdown and menu items finger-sized on phones ([#448](https://github.com/k2b-dev/cloud/issues/448)) ([8c843b3](https://github.com/k2b-dev/cloud/commit/8c843b31c93bf5a92c32177233fe973e9cfe77c7))
* **ui:** scroll the settings panel, not the dialog frame, when a hidden control takes focus ([#473](https://github.com/k2b-dev/cloud/issues/473)) ([849f439](https://github.com/k2b-dev/cloud/commit/849f439b2a11ee988e43eeb2668e83ffa9ef8a70))

## [0.24.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.23.0...cloud-v0.24.0) (2026-09-29)


### Features

* **accounts:** show the Cloud Login install step before pairing a device ([#386](https://github.com/k2b-dev/cloud/issues/386)) ([3a903f9](https://github.com/k2b-dev/cloud/commit/3a903f9375680cdbbfb84ca717b58139b714c552))
* **cloud:** give rendered PDFs their document title instead of a random file name ([#431](https://github.com/k2b-dev/cloud/issues/431)) ([325ce15](https://github.com/k2b-dev/cloud/commit/325ce1543eedda32b66eec36e2c43a98867c7255))
* **files:** open a previewed PDF in a new tab at a stable address ([#415](https://github.com/k2b-dev/cloud/issues/415)) ([6cdb6c9](https://github.com/k2b-dev/cloud/commit/6cdb6c9351a04300f8983c25d77a5827341f0d11))
* **venue:** clear shift states and wording, a calendar subscription, a comments filter, and no internal shift names in public ([#402](https://github.com/k2b-dev/cloud/issues/402)) ([0958280](https://github.com/k2b-dev/cloud/commit/0958280d328cb73cbd00329ad83288b9daacdb96))
* **venue:** navigation by role with a Public page view for admins ([#417](https://github.com/k2b-dev/cloud/issues/417)) ([b9f9276](https://github.com/k2b-dev/cloud/commit/b9f92761a5b7cfcb9c13765421ed26d465691478))
* **venue:** open a shift with one tap to take, leave, or manage it, also on phones ([#407](https://github.com/k2b-dev/cloud/issues/407)) ([7c1b283](https://github.com/k2b-dev/cloud/commit/7c1b283b91a26a7a02f1285a3069c315de890358))
* **venue:** remind staff before shifts and tell coordinators about cancellations and gaps ([#420](https://github.com/k2b-dev/cloud/issues/420)) ([609a67f](https://github.com/k2b-dev/cloud/commit/609a67f958d22769f7f3e7e0c686cd7a01ad2077))
* **venue:** set up and run a venue entirely from the interface ([#411](https://github.com/k2b-dev/cloud/issues/411)) ([cc80ba7](https://github.com/k2b-dev/cloud/commit/cc80ba7c2b3737fd3ed6ac8081060ef796d5e55c))
* **venue:** show upcoming exceptions on a calmer public page that matches its preview ([#414](https://github.com/k2b-dev/cloud/issues/414)) ([3c9bad6](https://github.com/k2b-dev/cloud/commit/3c9bad68f0eaaf31a05b30a4a0e1927c3ef617d0))


### Bug Fixes

* **cli:** use the local timezone for day-based filters ([#408](https://github.com/k2b-dev/cloud/issues/408)) ([84b50aa](https://github.com/k2b-dev/cloud/commit/84b50aaa4186e187f94e5c464efc3befab29921a)), closes [#333](https://github.com/k2b-dev/cloud/issues/333)
* **cloud:** keep Tailwind utilities above the property fallback layer in older browsers ([#426](https://github.com/k2b-dev/cloud/issues/426)) ([6729676](https://github.com/k2b-dev/cloud/commit/672967631f061eaee49ca8f87379801568ece666))
* **contacts:** let agent and standalone service accounts use their granted address books ([#410](https://github.com/k2b-dev/cloud/issues/410)) ([9f2e730](https://github.com/k2b-dev/cloud/commit/9f2e7306fd0c38517e05834d3a1104f8a8a43dc3)), closes [#289](https://github.com/k2b-dev/cloud/issues/289)
* **deps:** resolve fast-uri to 3.1.8 for GHSA-qw65-cvwx-89v3 and GHSA-58mr-gqgx-xq4g ([#438](https://github.com/k2b-dev/cloud/issues/438)) ([a1f8b57](https://github.com/k2b-dev/cloud/commit/a1f8b573c8f7b2724a45c53c7e293fb896ae3f7e))
* **files:** download or open a previewed PDF in a new tab ([#392](https://github.com/k2b-dev/cloud/issues/392)) ([ce978d1](https://github.com/k2b-dev/cloud/commit/ce978d1de3b2b60cc414a30308bc344577c52617))
* **files:** offer PDF actions only for PDFs and show loading instead of an error before the preview starts ([#434](https://github.com/k2b-dev/cloud/issues/434)) ([08e5c47](https://github.com/k2b-dev/cloud/commit/08e5c478bda33335f324d6f9033a1ba86a1d960f))
* **files:** open PDFs in a new tab at a Files page that signs in again and shows localized errors ([#423](https://github.com/k2b-dev/cloud/issues/423)) ([19d99a6](https://github.com/k2b-dev/cloud/commit/19d99a6bc43b88f96d8b50aaa6ff67203a4b79df))
* **grids:** keep chart axis values readable on phones ([#418](https://github.com/k2b-dev/cloud/issues/418)) ([e4c8c6e](https://github.com/k2b-dev/cloud/commit/e4c8c6ed17514613ee320c97008fa72dc6e6dbfb))
* **grids:** show people and groups in tables and Grids App record blocks ([#397](https://github.com/k2b-dev/cloud/issues/397)) ([c36f909](https://github.com/k2b-dev/cloud/commit/c36f909909b5d9695a18d97bdff322e4b5b58033)), closes [#332](https://github.com/k2b-dev/cloud/issues/332)
* **grids:** show that a new form is saved and let people finish ([#409](https://github.com/k2b-dev/cloud/issues/409)) ([16d9849](https://github.com/k2b-dev/cloud/commit/16d9849baa4185e9fadff30b5c5a82836c4f0d2a)), closes [#290](https://github.com/k2b-dev/cloud/issues/290)
* **grids:** size app charts to their block and show axis labels ([#406](https://github.com/k2b-dev/cloud/issues/406)) ([44b272d](https://github.com/k2b-dev/cloud/commit/44b272d1579320360620357524725299a44e2737)), closes [#323](https://github.com/k2b-dev/cloud/issues/323) [#324](https://github.com/k2b-dev/cloud/issues/324)
* **mail:** explain sync timeouts in Mailbox health, capitalize Conversation sections, and repair the nightly browser smokes ([#405](https://github.com/k2b-dev/cloud/issues/405)) ([4eaa30c](https://github.com/k2b-dev/cloud/commit/4eaa30c512704dedccd275893fb3433ef187b475)), closes [#334](https://github.com/k2b-dev/cloud/issues/334) [#335](https://github.com/k2b-dev/cloud/issues/335)
* **mail:** insert template placeholders as plain text and send links without brackets ([#394](https://github.com/k2b-dev/cloud/issues/394)) ([61145ab](https://github.com/k2b-dev/cloud/commit/61145abf68fe2c8fce5b927ae2a38562dc70e508))
* **mail:** search conversations by tag and show the tag name ([#388](https://github.com/k2b-dev/cloud/issues/388)) ([0b04cb5](https://github.com/k2b-dev/cloud/commit/0b04cb5eedbb8521f9d36c2383c2ebc303c7d38f))
* **mail:** show the remaining Mail interface texts in the reader's language ([#390](https://github.com/k2b-dev/cloud/issues/390)) ([a8bfba0](https://github.com/k2b-dev/cloud/commit/a8bfba0725dffca05296494afbd385f222e41dd0))
* **notebooks:** keep book view folders open or closed as the reader chose ([#396](https://github.com/k2b-dev/cloud/issues/396)) ([fbdea93](https://github.com/k2b-dev/cloud/commit/fbdea935af32acf37b2c6036050132c3a93c43c5)), closes [#363](https://github.com/k2b-dev/cloud/issues/363)
* **notebooks:** keep phone menu folds and settings categories usable on narrow screens ([#416](https://github.com/k2b-dev/cloud/issues/416)) ([4bedff0](https://github.com/k2b-dev/cloud/commit/4bedff059361d3f711e60d94a4f4fad5ef85da29))
* **notebooks:** stop reloading in a loop when live updates need a new sign-in ([#427](https://github.com/k2b-dev/cloud/issues/427)) ([7d4ae28](https://github.com/k2b-dev/cloud/commit/7d4ae283906f2794a5fbec6c067350b288214744))
* **ui:** give toast actions and close buttons finger-sized touch targets ([#435](https://github.com/k2b-dev/cloud/issues/435)) ([31174a7](https://github.com/k2b-dev/cloud/commit/31174a75b6b640366f5672ec19dde457ab353ae6))
* **ui:** keep phone header and settings close touch targets finger-sized without overlap ([#424](https://github.com/k2b-dev/cloud/issues/424)) ([9024d79](https://github.com/k2b-dev/cloud/commit/9024d7948687182472381dd1063301a975ae02a3))
* **ui:** keep phone tap areas clear of neighbouring controls and give the header Home link a finger-sized target ([#433](https://github.com/k2b-dev/cloud/issues/433)) ([b0be346](https://github.com/k2b-dev/cloud/commit/b0be34624d7840f0f4e87a4691958b9a47b899d5))
* **ui:** make compact controls, toasts and the detail panel work on phones ([#419](https://github.com/k2b-dev/cloud/issues/419)) ([fa92fd0](https://github.com/k2b-dev/cloud/commit/fa92fd081d435764f5247d2675ded32d84b20993))
* **ui:** make detail panel action rows finger-sized on phones ([#437](https://github.com/k2b-dev/cloud/issues/437)) ([9f68b99](https://github.com/k2b-dev/cloud/commit/9f68b99b0c6007547a66be4d2df99f3774df7219))
* **ui:** show built-in confirmation, toast and form messages in the reader's language ([#425](https://github.com/k2b-dev/cloud/issues/425)) ([8545490](https://github.com/k2b-dev/cloud/commit/8545490d8868491722bf299fe808336e0f0878d6))
* **venue:** keep the venue calendar token private and word calendar feeds and assistant text in the workspace language ([#430](https://github.com/k2b-dev/cloud/issues/430)) ([a36b252](https://github.com/k2b-dev/cloud/commit/a36b252fbe35671c5f209323592f16ad48da6814))
* **venue:** make sections, times, settings, sign-up, and feedback do what they say ([#391](https://github.com/k2b-dev/cloud/issues/391)) ([0615b11](https://github.com/k2b-dev/cloud/commit/0615b116cf262aa5b1e8bb4bda49408886cfa98b))
* **venue:** only offer sign-up to people who can, and show shifts you already joined ([#395](https://github.com/k2b-dev/cloud/issues/395)) ([e047cc6](https://github.com/k2b-dev/cloud/commit/e047cc67407597c491fb29d048e923cbed520adf))
* **venue:** open the right day from calendar links and show every feedback rating ([#422](https://github.com/k2b-dev/cloud/issues/422)) ([e381f9c](https://github.com/k2b-dev/cloud/commit/e381f9c978e0ad719461c81bd19c873eb2edc855))
* **venue:** polish schedule, feedback, monitor and public page details on desktop and phones ([#428](https://github.com/k2b-dev/cloud/issues/428)) ([72c9452](https://github.com/k2b-dev/cloud/commit/72c945262ab3effc4a1b50a0d2dbe0a702cb0629))
* **venue:** show visitor feedback and hidden sections only to staff and admins ([#387](https://github.com/k2b-dev/cloud/issues/387)) ([4f4391f](https://github.com/k2b-dev/cloud/commit/4f4391f9fe5fcbab415c6bac4968d51aea3f03a0))

## [0.23.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.22.0...cloud-v0.23.0) (2026-09-28)


### Features

* **notebooks:** indent with Tab in the note editor ([#384](https://github.com/k2b-dev/cloud/issues/384)) ([f1b743c](https://github.com/k2b-dev/cloud/commit/f1b743c7b53f44d346762f963ea6f16bab9778b9))


### Bug Fixes

* **venue:** accept public venue IDs in every authenticated request ([#382](https://github.com/k2b-dev/cloud/issues/382)) ([0164513](https://github.com/k2b-dev/cloud/commit/01645131cfcccc8bac36527cf5f2262cd9dabce7)), closes [#381](https://github.com/k2b-dev/cloud/issues/381)

## [0.22.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.21.0...cloud-v0.22.0) (2026-09-28)


### Features

* **accounts:** allow local accounts without email when enabled ([#371](https://github.com/k2b-dev/cloud/issues/371)) ([9b46e69](https://github.com/k2b-dev/cloud/commit/9b46e6964d558eeee8af77e132707cf5cfc79400))
* **accounts:** let admins revoke a user's paired sign-in devices ([#369](https://github.com/k2b-dev/cloud/issues/369)) ([a0ac811](https://github.com/k2b-dev/cloud/commit/a0ac8115b555172b042051a63abb27170344867b))
* **assistant:** turn HTML with CSS into PDF ([#367](https://github.com/k2b-dev/cloud/issues/367)) ([f3467ea](https://github.com/k2b-dev/cloud/commit/f3467eadb0649f6f28b6e0f36599195626eed994))
* **cloud:** render every HTML-to-PDF path offline ([#354](https://github.com/k2b-dev/cloud/issues/354)) ([5c2f159](https://github.com/k2b-dev/cloud/commit/5c2f159439b3b3c8a8d69651d051e1043c388597))
* **grids:** keep table columns in sync when fields change ([#360](https://github.com/k2b-dev/cloud/issues/360)) ([1648231](https://github.com/k2b-dev/cloud/commit/1648231104448fc6995786a5560430f027c4f40c))
* **pwa-auth:** show which account each connected Cloud signs in ([#358](https://github.com/k2b-dev/cloud/issues/358)) ([a123878](https://github.com/k2b-dev/cloud/commit/a123878ce8b1cde33130bce98dc758a897a78603))
* **ui:** add an inline Placeholder for empty lists and use it in empty notebooks ([#365](https://github.com/k2b-dev/cloud/issues/365)) ([792c256](https://github.com/k2b-dev/cloud/commit/792c256f2798d9ac3efbe237bffbf24331617ed1)), closes [#359](https://github.com/k2b-dev/cloud/issues/359)


### Bug Fixes

* **apps:** use the shared inline placeholder for empty lists ([#372](https://github.com/k2b-dev/cloud/issues/372)) ([bdb6550](https://github.com/k2b-dev/cloud/commit/bdb6550d53e614d85ae151e1104e376121f1c27c))
* **assistant:** align fullscreen Studio apps with the workspace frame ([#368](https://github.com/k2b-dev/cloud/issues/368)) ([d9789f0](https://github.com/k2b-dev/cloud/commit/d9789f05e2fd2a3a051da4357997176c83b58916))
* **cloud:** use the flat app background on phones in dark mode ([#376](https://github.com/k2b-dev/cloud/issues/376)) ([b8c465f](https://github.com/k2b-dev/cloud/commit/b8c465f7d7309d97412dd9c9cfb97658d090f1e0))
* **deps:** resolve lodash-es to 4.18.1 for GHSA-r5fr-rjxr-66jc ([#356](https://github.com/k2b-dev/cloud/issues/356)) ([5b53e85](https://github.com/k2b-dev/cloud/commit/5b53e859df2dd8495078eaf89f62b10dc3f1527e))
* **files:** keep the trash out of the sidebar folder tree ([#370](https://github.com/k2b-dev/cloud/issues/370)) ([034526a](https://github.com/k2b-dev/cloud/commit/034526a3ccd8b1a8a5b2602127a43287ead6afb4))
* **files:** mark the active row in list mode like in tree mode ([#366](https://github.com/k2b-dev/cloud/issues/366)) ([ad5dd1a](https://github.com/k2b-dev/cloud/commit/ad5dd1ab66f8c758e1c0e89c46e590df74c475fd)), closes [#361](https://github.com/k2b-dev/cloud/issues/361)
* **grids:** keep search fields in step with the table schema ([#380](https://github.com/k2b-dev/cloud/issues/380)) ([c52f133](https://github.com/k2b-dev/cloud/commit/c52f133c62967b84e9067b8e23ff289eab9d7435))
* **grids:** reload filtered and sorted table URLs ([#375](https://github.com/k2b-dev/cloud/issues/375)) ([a3978d6](https://github.com/k2b-dev/cloud/commit/a3978d672a479097658df305dc62fc1e01442f86))
* **grids:** render loaded records without the loading state ([#379](https://github.com/k2b-dev/cloud/issues/379)) ([dceddb4](https://github.com/k2b-dev/cloud/commit/dceddb491e984a1500da889c2d1827a0cbccd33c))
* **grids:** show record titles in group details ([#378](https://github.com/k2b-dev/cloud/issues/378)) ([9cdd084](https://github.com/k2b-dev/cloud/commit/9cdd084bd186724d0996c85e3cfff2417de8d7c5))
* **pwa-auth:** keep Cloud Login still and simplify the PIN prompt ([#350](https://github.com/k2b-dev/cloud/issues/350)) ([43dfe36](https://github.com/k2b-dev/cloud/commit/43dfe3635f2c8fcb1f8090ef3281d2b8532520be))
* **ui:** load more table rows when the page scrolls ([#377](https://github.com/k2b-dev/cloud/issues/377)) ([a9d4e6d](https://github.com/k2b-dev/cloud/commit/a9d4e6dfca2971fb154ca5470ddde25c5dbdc0f6))
* **ui:** show how many selections a narrow multi-select hides ([#357](https://github.com/k2b-dev/cloud/issues/357)) ([38c1b2c](https://github.com/k2b-dev/cloud/commit/38c1b2cc7e2102e3de553dfd588bf5187cc45638))

## [0.21.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.20.0...cloud-v0.21.0) (2026-09-27)


### Features

* **assistant:** delete chat files from the Files list ([#347](https://github.com/k2b-dev/cloud/issues/347)) ([5246601](https://github.com/k2b-dev/cloud/commit/52466014b27cc5405041ecfe4a8c01fe9709483a))
* **spaces:** group the item detail panel by planning, content, work, and context ([#325](https://github.com/k2b-dev/cloud/issues/325)) ([38436fa](https://github.com/k2b-dev/cloud/commit/38436fac87380971530c6b7b1471f299da6667ea)), closes [#322](https://github.com/k2b-dev/cloud/issues/322)
* **spaces:** keep dropped cards where they land in paged Kanban columns ([#327](https://github.com/k2b-dev/cloud/issues/327)) ([174b2e3](https://github.com/k2b-dev/cloud/commit/174b2e319af571c7522de559ddf23520d7cdd853)), closes [#312](https://github.com/k2b-dev/cloud/issues/312)


### Bug Fixes

* **cloud:** keep lone reasoning rows at the full chat column width ([#340](https://github.com/k2b-dev/cloud/issues/340)) ([cc85a41](https://github.com/k2b-dev/cloud/commit/cc85a41f9670f51656eaab2bdcfb63a4ae13c07e))
* **grids:** keep all columns visible when saving a field on a new table ([#344](https://github.com/k2b-dev/cloud/issues/344)) ([f0988ad](https://github.com/k2b-dev/cloud/commit/f0988ad1c7e1d0ae216a4762f0a6cc4d99f1e0ee)), closes [#330](https://github.com/k2b-dev/cloud/issues/330)
* **grids:** keep the records search on one line ([#346](https://github.com/k2b-dev/cloud/issues/346)) ([a7b7520](https://github.com/k2b-dev/cloud/commit/a7b75200a9ba45d9b24109f9fd301a9085d43ab8))
* **grids:** show linked record labels in relation cells, pickers, and filters ([#339](https://github.com/k2b-dev/cloud/issues/339)) ([0491e6e](https://github.com/k2b-dev/cloud/commit/0491e6e7d294e6327ae85b5e5c4347b6a12a5300))
* **grids:** show record loading in the search icon instead of a transient refresh button ([#342](https://github.com/k2b-dev/cloud/issues/342)) ([6fccac8](https://github.com/k2b-dev/cloud/commit/6fccac8bbfd68cd66c934ec0cb44457369ac62c8)), closes [#329](https://github.com/k2b-dev/cloud/issues/329)
* **spaces:** read CLI dates in the user's timezone like the web interface ([#348](https://github.com/k2b-dev/cloud/issues/348)) ([93fe6b5](https://github.com/k2b-dev/cloud/commit/93fe6b5f303dd19045772b0ff33828b167958a43))
* **test:** delete the Sync namespaces integration tests leave on the broker ([#328](https://github.com/k2b-dev/cloud/issues/328)) ([42709f2](https://github.com/k2b-dev/cloud/commit/42709f232cd8bd1489b32f5db40f09781b370edd))
* **ui:** keep sidebar row menus open while the pointer moves into them ([#338](https://github.com/k2b-dev/cloud/issues/338)) ([fdae52d](https://github.com/k2b-dev/cloud/commit/fdae52de7bbedbb5fbfed050d37cc7ffdd6398f7))
* **ui:** preview PDFs from loaded bytes when no inline URL exists ([#341](https://github.com/k2b-dev/cloud/issues/341)) ([1f15850](https://github.com/k2b-dev/cloud/commit/1f158501cb1d84dacc81db58abf6a92d2a0590f7))
* **ui:** reveal a nav tree row's actions only for that row ([#343](https://github.com/k2b-dev/cloud/issues/343)) ([f039ab2](https://github.com/k2b-dev/cloud/commit/f039ab2ba1e99226d2746c86582cc8c3b415c5e5))

## [0.20.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.19.3...cloud-v0.20.0) (2026-09-27)


### Features

* **cli:** remove a profile with cld profile rm ([#304](https://github.com/k2b-dev/cloud/issues/304)) ([961c12a](https://github.com/k2b-dev/cloud/commit/961c12affc66b0770fdef7b143a27a95dbfe0d75)), closes [#281](https://github.com/k2b-dev/cloud/issues/281)


### Bug Fixes

* **apps:** color the Files selection marquee and show the Grids card focus ring ([#317](https://github.com/k2b-dev/cloud/issues/317)) ([c0d1c95](https://github.com/k2b-dev/cloud/commit/c0d1c95a41eab70aa1283f39e9913c4d19fc8417)), closes [#313](https://github.com/k2b-dev/cloud/issues/313)
* **cli:** print help for core cld commands instead of running them ([#299](https://github.com/k2b-dev/cloud/issues/299)) ([73641dd](https://github.com/k2b-dev/cloud/commit/73641ddac48f6fe0363f0e3261cff36c141d8bfe)), closes [#282](https://github.com/k2b-dev/cloud/issues/282)
* **cloud:** keep mixed token colors in compiled stylesheets ([#319](https://github.com/k2b-dev/cloud/issues/319)) ([9b9e937](https://github.com/k2b-dev/cloud/commit/9b9e937fcb10cc8cff9be794e42f851d1993ec28)), closes [#315](https://github.com/k2b-dev/cloud/issues/315)
* **cloud:** keep the PDF decoder within its memory limit on many-core hosts ([#318](https://github.com/k2b-dev/cloud/issues/318)) ([94cb4ff](https://github.com/k2b-dev/cloud/commit/94cb4ffd73f1f12f2a8e9d06a3174fa12bf004f6)), closes [#314](https://github.com/k2b-dev/cloud/issues/314)
* **cloud:** show agent and standalone service-account grants in access list tables ([#306](https://github.com/k2b-dev/cloud/issues/306)) ([4114ccf](https://github.com/k2b-dev/cloud/commit/4114ccf921215a56be2545c86a54b7ca3e4a1c36)), closes [#295](https://github.com/k2b-dev/cloud/issues/295)
* **cloud:** stop page content from shifting when the scrollbar appears ([#309](https://github.com/k2b-dev/cloud/issues/309)) ([aef9539](https://github.com/k2b-dev/cloud/commit/aef9539bb169a87693f24d98a7783df116d4c80e)), closes [#287](https://github.com/k2b-dev/cloud/issues/287)
* **mail:** let mailboxes take turns hydrating message bodies ([#311](https://github.com/k2b-dev/cloud/issues/311)) ([718f335](https://github.com/k2b-dev/cloud/commit/718f3357eb6ff85cbe6282019f5cd5a23f820427)), closes [#294](https://github.com/k2b-dev/cloud/issues/294)
* **mail:** recover a transiently degraded mailbox on its next sync ([#307](https://github.com/k2b-dev/cloud/issues/307)) ([8b0f9cb](https://github.com/k2b-dev/cloud/commit/8b0f9cb1a950e2bece7e91ee0cbcae985cf45378)), closes [#291](https://github.com/k2b-dev/cloud/issues/291)
* **mail:** refresh the open reader when message body hydration completes ([#301](https://github.com/k2b-dev/cloud/issues/301)) ([d2a43d4](https://github.com/k2b-dev/cloud/commit/d2a43d4f864af45ceddd7d01e493ccd9cdcfc46f)), closes [#293](https://github.com/k2b-dev/cloud/issues/293)
* **mail:** stop a hung provider rediscovery from starving other mailboxes ([#302](https://github.com/k2b-dev/cloud/issues/302)) ([2df030c](https://github.com/k2b-dev/cloud/commit/2df030cd49cccb81530a420038a9609cd3b66a61)), closes [#292](https://github.com/k2b-dev/cloud/issues/292)
* **notebooks:** rewrite note links to mirror file paths in cld notebooks pull ([#308](https://github.com/k2b-dev/cloud/issues/308)) ([1fb425a](https://github.com/k2b-dev/cloud/commit/1fb425a658050a2e61c93a84a63b16e421f15791)), closes [#277](https://github.com/k2b-dev/cloud/issues/277)
* **spaces:** show one avatar initials style, localize the detail Edit button, and stop claim clicks leaking computations ([#316](https://github.com/k2b-dev/cloud/issues/316)) ([970bc87](https://github.com/k2b-dev/cloud/commit/970bc87416f996dadfa8cfcd917656576e0cf322))
* **spaces:** show the claim holder like an assignee, confirm take-overs, and add the card claim tooltip ([#298](https://github.com/k2b-dev/cloud/issues/298)) ([6524b8b](https://github.com/k2b-dev/cloud/commit/6524b8b13b58634f25b4ebdea81e8593a2bfb258)), closes [#296](https://github.com/k2b-dev/cloud/issues/296) [#285](https://github.com/k2b-dev/cloud/issues/285)
* **spaces:** show where a dragged card will land on the Kanban board ([#303](https://github.com/k2b-dev/cloud/issues/303)) ([201e3e3](https://github.com/k2b-dev/cloud/commit/201e3e347a797627543ef426d829d61fb9571fbb)), closes [#288](https://github.com/k2b-dev/cloud/issues/288)

## [0.19.3](https://github.com/k2b-dev/cloud/compare/cloud-v0.19.2...cloud-v0.19.3) (2026-09-26)


### Bug Fixes

* **access:** let standalone and agent service accounts use their Spaces and Notebooks grants ([#286](https://github.com/k2b-dev/cloud/issues/286)) ([4093af9](https://github.com/k2b-dev/cloud/commit/4093af9bc7504b2632a02ea9b2662b85b12da92f))
* **dev:** keep the dev CLI's state inside the checkout ([#280](https://github.com/k2b-dev/cloud/issues/280)) ([d02ad19](https://github.com/k2b-dev/cloud/commit/d02ad191281f583016d6f71000f725607078d536))
* **dev:** pass APP_URL to the development containers ([#284](https://github.com/k2b-dev/cloud/issues/284)) ([c08c28e](https://github.com/k2b-dev/cloud/commit/c08c28e2497eb64f62e5dacf15126d44fc1ae421))

## [0.19.2](https://github.com/k2b-dev/cloud/compare/cloud-v0.19.1...cloud-v0.19.2) (2026-09-26)


### Bug Fixes

* **cli:** ask for the skill target when an upgraded config has none ([#276](https://github.com/k2b-dev/cloud/issues/276)) ([079f481](https://github.com/k2b-dev/cloud/commit/079f481f4b73d311b0ddfea5ffa1401d9c742dfc))
* **cli:** let cld update finish slow downloads ([#275](https://github.com/k2b-dev/cloud/issues/275)) ([fc28fe1](https://github.com/k2b-dev/cloud/commit/fc28fe10a2f42f8e85a353a7b682cf12d1d9a98f))

## [0.19.1](https://github.com/k2b-dev/cloud/compare/cloud-v0.19.0...cloud-v0.19.1) (2026-09-26)


### Bug Fixes

* **grids:** keep the workspace revision header out of the server module the browser bundles ([#270](https://github.com/k2b-dev/cloud/issues/270)) ([3093e2d](https://github.com/k2b-dev/cloud/commit/3093e2d94cc955f79a6f0f936110705c6b202d38))

## [0.19.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.18.0...cloud-v0.19.0) (2026-09-26)


### ⚠ BREAKING CHANGES

* **cli:** write the cloud-cli agent skill with every installed module's references ([#265](https://github.com/k2b-dev/cloud/issues/265))
* **cli:** serve every first-party module as a plugin of its application ([#261](https://github.com/k2b-dev/cloud/issues/261))
* **cli:** install and lock each profile's served plugins ([#255](https://github.com/k2b-dev/cloud/issues/255))

### Features

* **cli:** install and lock each profile's served plugins ([#255](https://github.com/k2b-dev/cloud/issues/255)) ([4c6be90](https://github.com/k2b-dev/cloud/commit/4c6be90b748ba77fcaf736ea8ce4f67b4c96439b))
* **cli:** serve every first-party module as a plugin of its application ([#261](https://github.com/k2b-dev/cloud/issues/261)) ([40a9690](https://github.com/k2b-dev/cloud/commit/40a9690ce5843a08bbc60e5117fb967be9e51396))
* **cli:** write the cloud-cli agent skill with every installed module's references ([#265](https://github.com/k2b-dev/cloud/issues/265)) ([f02142d](https://github.com/k2b-dev/cloud/commit/f02142d56db75451401e304bf9e96e0bdbd336ea))
* **cloud:** serve each app's cld plugin and skill references from the app ([#253](https://github.com/k2b-dev/cloud/issues/253)) ([c89ffa0](https://github.com/k2b-dev/cloud/commit/c89ffa0d4dd6406d9d0246844ff307a0f31c6e54))
* **core:** merge the account overview into the profile page ([#260](https://github.com/k2b-dev/cloud/issues/260)) ([8eb4540](https://github.com/k2b-dev/cloud/commit/8eb45401efc55ff470fa8e51e1ef9488adb39988))
* **spaces:** let people claim, release, and take over tasks from the board and details ([#266](https://github.com/k2b-dev/cloud/issues/266)) ([9fb4cc3](https://github.com/k2b-dev/cloud/commit/9fb4cc31aea41050eaa6c72d5fc65b688d39035e))
* **spaces:** link items to GitHub issues and external pages ([#267](https://github.com/k2b-dev/cloud/issues/267)) ([335aa41](https://github.com/k2b-dev/cloud/commit/335aa41876f4e82312827cdb0cbd3d4b4aa7d639)), closes [#263](https://github.com/k2b-dev/cloud/issues/263)


### Bug Fixes

* **core:** polish account pages and settings source labels ([#259](https://github.com/k2b-dev/cloud/issues/259)) ([c73dbf8](https://github.com/k2b-dev/cloud/commit/c73dbf80b3bd345b8aa5036ef0f5d99f3fc51d5a))
* **grids:** keep saving while the workspace notice only informs ([#258](https://github.com/k2b-dev/cloud/issues/258)) ([53b4809](https://github.com/k2b-dev/cloud/commit/53b48095ed9853b0d49acdf8824a1cd7310d3ebe))
* **grids:** open shared views that filter on non-selected fields ([#257](https://github.com/k2b-dev/cloud/issues/257)) ([ef53ec7](https://github.com/k2b-dev/cloud/commit/ef53ec70ca2a7557743ecde85cab8e3dfdd982bd)), closes [#256](https://github.com/k2b-dev/cloud/issues/256)

## [0.18.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.17.0...cloud-v0.18.0) (2026-09-26)


### ⚠ BREAKING CHANGES

* **grids:** `cld grids` renamed `list`/`bases list` → `bases ls`, `bases|tables|records get|create|update|delete` → `show|add|set|rm`, and `tables list`/`records list` → `ls`, without aliases.
* **mail:** renamed everyday `cld mail` commands without aliases: `list`→`ls`, `conversation list`→`ls <mailbox>[:<folder>]`, `conversation get`→`show`, `message get`→`cat`, `conversation assign`→`assign … --to`, `conversation archive|move|trash|read|unread|star|unstar`→`archive|mv --to|rm --yes|read|unread|flag|unflag` with `--in` instead of `--source`, `conversation tag add`→`tag add`, `comment list|add|edit|delete`→`comments list|add|update|delete`, `send` now sends an existing draft (`send <draft>`); `conversation junk|not-spam|keyword` take `--in` and `--keyword`.
* **filesv2:** the old cld filesv2 commands are removed without aliases. bases list -> ls; list <base> --path P -> ls <area>:/P; stat <base> P -> stat <file>; download <base> P --out F -> get <file> [F]; archive -> get <folder> or zip <entry>... --out F; upload <base> F --to P -> put F <file> [--parents]; mkdir <base> P -> mkdir [-p] <folder>; rename -> mv in the same folder; move --to -> mv <entry>... <folder>/; copy --to [--target-base] -> cp <entry>... <folder>; delete -> rm --yes; search <base> Q --path P -> search <folder> Q; trash list|restore <base> -> trash list|restore <area>; versions download -> versions get; versions comment -> versions update --comment; shares create -> shares add; shares revoke -> shares rm --yes; documents markdown -> documents create --kind markdown; thumbnail --out F -> thumbnail <file> F; templates get -> templates show; templates use <id> <base> P -> templates use <id> <file>; admin templates import <base> P -> admin templates import <file>; admin --area -> --storage; admin files list|download|delete -> admin files ls|get|rm <storage>/<kind>/<name>:/P or <storage>/archive/<id>:/P; admin versions list|delete and admin directories archive|retire|delete take the same directory address; admin shares revoke -> admin shares rm --yes. Every other command keeps its name and file arguments use the new address form.
* **spaces:** `cld spaces` command names changed without aliases. `list` → `ls`; `use`/`current` removed; `get` → `show <space>:`; `items` → `ls <space>`; `item` → `show`; `add-item` → `add <space>:<title>`; `update-item` → `set` (`--column` → `mv`); `blockers`/`blocks`/`block`/`unblock` → `deps [--add|--rm]`; `comments`/`comment` → `comments list|add`; `attachments`/`add-attachment`/`download-attachment`/`delete-attachment` → `attachments list|add|download|delete`; `references remove` → `references delete`; `calendar`/`overlap --from --to` → `<start> <end>`; `--file`/`--stdin` → `--from`; `--page-size` → `--per-page`; `--output` → `--out`; `--space` → addresses.
* **contacts:** address contacts by book and name and use the shared CLI verbs ([#247](https://github.com/k2b-dev/cloud/issues/247))
* **notebooks:** `cld notebooks` command names changed without aliases. `list` → `ls`; `use`/`current` removed; `get` → `stat <notebook>:`; `notes` → `ls <notebook>[:<path>]`; `note`/`content`/`read` → `stat`/`cat`; `block` → `cat --block`; `create-note` → `write <notebook>:<path> [--parents]`; `edit --set-content` → `write`; `move-note` → `mv`; `copy-note` → `cp`; `delete-note` → `rm`; `lock-note` → `lock`; `search --all`/`tag-notes` → `search [--notebook] [--tags]`; `favorite`/`unfavorite`/`favorites` → `favorites add|remove|list`; `comments`/`add-comment`/`update-comment`/`delete-comment` → `comments list|add|update|delete`; `versions`/`version`/`restore-version` → `versions list|cat|restore --into`; `upload-attachment` → `attach`; `attachments`/`download-attachment`/`delete-attachment` → `attachments list|download|delete`; `attachment`/`attachment-usage` → `attachments list --json` / shown by `attachments delete`; `create-from-template` → `create --template`; `api-keys`/`create-api-key`/`revoke-api-key` → `api-keys list|create|revoke`; `snapshot`/`update-snapshot`/`snapshot-logs`/`run-snapshot` → `snapshots show|set|logs|run`. `--notebook`/`--note` flags are replaced by addresses; `--file`/`--stdin` by `--from <file|->`; `--output-file` by `--out`. `cld notebooks create` makes an empty notebook.

### Features

* **cli:** share the command convention and address parsing for app CLIs ([#244](https://github.com/k2b-dev/cloud/issues/244)) ([3567c29](https://github.com/k2b-dev/cloud/commit/3567c29be73fd11522cde91516b0da119366ea51))
* **contacts:** address contacts by book and name and use the shared CLI verbs ([#247](https://github.com/k2b-dev/cloud/issues/247)) ([6fc4f10](https://github.com/k2b-dev/cloud/commit/6fc4f101fd38692d7262cfdaa863067d97c9d42c))
* **filesv2:** address files by area and path and use shell-like CLI verbs ([#249](https://github.com/k2b-dev/cloud/issues/249)) ([063e058](https://github.com/k2b-dev/cloud/commit/063e058c80c4b49450879ce57fe0b9743c646f76))
* **grids:** address bases, tables and records the shared way ([#250](https://github.com/k2b-dev/cloud/issues/250)) ([bb26d6a](https://github.com/k2b-dev/cloud/commit/bb26d6ad7dd5fefa727a208a046a2bf4fa62aaa5))
* **mail:** short shared verbs and mailbox/folder addressing for everyday CLI commands ([#251](https://github.com/k2b-dev/cloud/issues/251)) ([74354ee](https://github.com/k2b-dev/cloud/commit/74354eee32623f91c0b19e4dc6334218c61b5beb))
* **notebooks:** address notes by path and mirror notebooks as Markdown folders ([#241](https://github.com/k2b-dev/cloud/issues/241)) ([172bd53](https://github.com/k2b-dev/cloud/commit/172bd534987438c1222a2aad8cabe29a63788444))
* **spaces:** address items by space and title and use the shared CLI verbs ([#248](https://github.com/k2b-dev/cloud/issues/248)) ([9b2cdb6](https://github.com/k2b-dev/cloud/commit/9b2cdb6e7338044704723a13bafbd192f6fb0b8c))


### Bug Fixes

* **filesv2:** name the share command revoke ([#252](https://github.com/k2b-dev/cloud/issues/252)) ([086be50](https://github.com/k2b-dev/cloud/commit/086be5076fa334b5faa6d73aa1ad720ecb158369))
* **mail:** keep common template styles such as inline-block buttons in received HTML mail ([#246](https://github.com/k2b-dev/cloud/issues/246)) ([0d4d450](https://github.com/k2b-dev/cloud/commit/0d4d450613f4c54c0fc9329a7dd58b2d86ed97e6))
* **ui:** open bottom sheets without a focus ring and extend the footer into the safe area ([#243](https://github.com/k2b-dev/cloud/issues/243)) ([fa82d9b](https://github.com/k2b-dev/cloud/commit/fa82d9bb2df4f310287df67f60f8048e3bc8d804))


### Performance Improvements

* **cli:** load only the module a command needs ([#245](https://github.com/k2b-dev/cloud/issues/245)) ([cce4711](https://github.com/k2b-dev/cloud/commit/cce4711d08c432bf3f5fe483578cbb8b37ab0531))

## [0.17.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.16.0...cloud-v0.17.0) (2026-09-25)


### Features

* **cli:** sign in on headless machines with cld login --device ([#236](https://github.com/k2b-dev/cloud/issues/236)) ([199850f](https://github.com/k2b-dev/cloud/commit/199850f6b6ea191063f6ab8a808eeba27cc0b5f2))
* **cloud:** send sign-in push hints to paired devices ([#232](https://github.com/k2b-dev/cloud/issues/232)) ([7227cff](https://github.com/k2b-dev/cloud/commit/7227cff17d30bb31ed7ae8bedfc327e934aa27dc))
* **mail:** assign many conversations at once ([#238](https://github.com/k2b-dev/cloud/issues/238)) ([eb3c9ff](https://github.com/k2b-dev/cloud/commit/eb3c9ff21fdd080eb10fe2d626523c85d5022685))
* **notebooks:** show callout blocks with colour only ([#226](https://github.com/k2b-dev/cloud/issues/226)) ([e75336d](https://github.com/k2b-dev/cloud/commit/e75336dc59f29d0b9f80a3b2bd58ae9039132ea1))
* **oauth:** support the device authorization grant ([#235](https://github.com/k2b-dev/cloud/issues/235)) ([2ef8d79](https://github.com/k2b-dev/cloud/commit/2ef8d795797a82767c74b47e61c006b3e463d736))
* **pwa-auth:** wake Cloud Login with push notifications ([#230](https://github.com/k2b-dev/cloud/issues/230)) ([ffe639a](https://github.com/k2b-dev/cloud/commit/ffe639ac4c6ee5fb26022c65e10a14fcb177b6c5))


### Bug Fixes

* **mail:** accept real folder ids in guided move_to_folder automations ([#227](https://github.com/k2b-dev/cloud/issues/227)) ([8d743e5](https://github.com/k2b-dev/cloud/commit/8d743e5392a3e6efa5d162b099574b0222a64474)), closes [#216](https://github.com/k2b-dev/cloud/issues/216)
* **mail:** accept tag names and name unknown tags in guided add_local_tag automations ([#234](https://github.com/k2b-dev/cloud/issues/234)) ([b495d3f](https://github.com/k2b-dev/cloud/commit/b495d3fc4d6405d9a9d9fb4a9636061af8791537)), closes [#231](https://github.com/k2b-dev/cloud/issues/231)
* **notebooks:** show toolbar focus as a blue icon instead of a clipped ring ([#229](https://github.com/k2b-dev/cloud/issues/229)) ([7f1e04f](https://github.com/k2b-dev/cloud/commit/7f1e04ff006a3f1f4670a3c5cbd72aad6e5b04c3))
* **ui:** localize default toast titles ([#239](https://github.com/k2b-dev/cloud/issues/239)) ([9bcf6e9](https://github.com/k2b-dev/cloud/commit/9bcf6e90b02f7da8d7a123977cb3f45a2079befe))

## [0.16.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.15.0...cloud-v0.16.0) (2026-09-24)


### Features

* **accounts:** capitalise group names for display in German ([#202](https://github.com/k2b-dev/cloud/issues/202)) ([08b34e9](https://github.com/k2b-dev/cloud/commit/08b34e9a5d7e57da8d406a88b1c85644ba7cb0b1))
* **accounts:** hide personal Linux groups from group lists and pickers by default ([#197](https://github.com/k2b-dev/cloud/issues/197)) ([1e640c4](https://github.com/k2b-dev/cloud/commit/1e640c453cdb83bb87f8f405cb93b843f71ac475))
* **filesv2:** show display names next to usernames in the directory admin list ([#195](https://github.com/k2b-dev/cloud/issues/195)) ([e893392](https://github.com/k2b-dev/cloud/commit/e8933925fe6c47d606f424732c491eb038c7d223))
* **mail:** name folders by path in move approvals and folder maintenance ([#223](https://github.com/k2b-dev/cloud/issues/223)) ([71da4a2](https://github.com/k2b-dev/cloud/commit/71da4a2dd0401006405ca5a9f34ff4a36a571e28))
* **notebooks:** show typographic ligatures for arrows and symbols ([#196](https://github.com/k2b-dev/cloud/issues/196)) ([52b0d0b](https://github.com/k2b-dev/cloud/commit/52b0d0b3c04e4105b92dbee6a5c5fbf5032e5085))
* **notebooks:** zoom, pan, and open Mermaid diagrams fullscreen ([#194](https://github.com/k2b-dev/cloud/issues/194)) ([b88ac25](https://github.com/k2b-dev/cloud/commit/b88ac253479f3ba01676383fe06107cd31813614))


### Bug Fixes

* **cli:** flush complete output before exiting ([#212](https://github.com/k2b-dev/cloud/issues/212)) ([4937f49](https://github.com/k2b-dev/cloud/commit/4937f4990ff76834352f4f47aad2e5248a0d91c6))
* **cloud:** bound automatic page reloads so live errors cannot loop ([#221](https://github.com/k2b-dev/cloud/issues/221)) ([cd513d8](https://github.com/k2b-dev/cloud/commit/cd513d8f4220612a966ffc5517d4e4e05dd944b5))
* **core:** delete passkeys reliably and explain failures ([#203](https://github.com/k2b-dev/cloud/issues/203)) ([b72e51f](https://github.com/k2b-dev/cloud/commit/b72e51f6c3ec1b2004be0509c400f1787abe13d6))
* **core:** finish app sign-in immediately without flashing the form ([#191](https://github.com/k2b-dev/cloud/issues/191)) ([074825d](https://github.com/k2b-dev/cloud/commit/074825df64a25681787b848be83b668dd37c044b))
* **mail:** archive Gmail conversations to All Mail ([#218](https://github.com/k2b-dev/cloud/issues/218)) ([204e6b2](https://github.com/k2b-dev/cloud/commit/204e6b2826ecd063e4e050e353c396008fa11a6c)), closes [#211](https://github.com/k2b-dev/cloud/issues/211)
* **mail:** filter search by folder id and reject unknown folders ([#215](https://github.com/k2b-dev/cloud/issues/215)) ([354d486](https://github.com/k2b-dev/cloud/commit/354d486c7178aadb977bb1f1dfcbfb8947aa9fa3)), closes [#209](https://github.com/k2b-dev/cloud/issues/209)
* **mail:** let archive automations use Gmail's All Mail ([#225](https://github.com/k2b-dev/cloud/issues/225)) ([f5c0734](https://github.com/k2b-dev/cloud/commit/f5c0734950aa6d52202cc11e5f9ff8e6483fc68b))
* **mail:** name the invalid field in automation definition errors ([#220](https://github.com/k2b-dev/cloud/issues/220)) ([82c7079](https://github.com/k2b-dev/cloud/commit/82c7079b9308b99c4511d84a0c5df8569cb71b44)), closes [#208](https://github.com/k2b-dev/cloud/issues/208)
* **mail:** report limited backfills and keep their progress monotonic ([#219](https://github.com/k2b-dev/cloud/issues/219)) ([11ac285](https://github.com/k2b-dev/cloud/commit/11ac2854f791ce4221887c64a7ebf64498c422cf)), closes [#207](https://github.com/k2b-dev/cloud/issues/207)
* **mail:** serve the automation catalog without a 500 ([#214](https://github.com/k2b-dev/cloud/issues/214)) ([357be49](https://github.com/k2b-dev/cloud/commit/357be499d2196583ba4b490b87fea82f4c757ae9)), closes [#206](https://github.com/k2b-dev/cloud/issues/206)
* **mail:** set up the default sender after connecting and explain partial success ([#205](https://github.com/k2b-dev/cloud/issues/205)) ([58fd537](https://github.com/k2b-dev/cloud/commit/58fd537e3ed2de2c0a59574de5ed0def68c1f080)), closes [#198](https://github.com/k2b-dev/cloud/issues/198)
* **mail:** show IMAP folders as a tree again ([#204](https://github.com/k2b-dev/cloud/issues/204)) ([778fb9c](https://github.com/k2b-dev/cloud/commit/778fb9cf0cf2e19dd4a34d3740ff6b5708e1f8b0)), closes [#200](https://github.com/k2b-dev/cloud/issues/200)
* **mail:** show the provider's error detail with invalid-input messages ([#222](https://github.com/k2b-dev/cloud/issues/222)) ([6b82311](https://github.com/k2b-dev/cloud/commit/6b82311ec309b484205256a14abeb72479dbc770))
* **notebooks:** let the CLI edit notes that are open in the editor ([#213](https://github.com/k2b-dev/cloud/issues/213)) ([8f8fcb8](https://github.com/k2b-dev/cloud/commit/8f8fcb84344407e78fff33b253775c2dbc36caab))
* **notebooks:** show top-level notes without sub-notes in the navigator ([#190](https://github.com/k2b-dev/cloud/issues/190)) ([20c790f](https://github.com/k2b-dev/cloud/commit/20c790f3b8322bef6f9059c84524ea8174c58ff3))
* **ui:** align entity search results left with the action on the right ([#192](https://github.com/k2b-dev/cloud/issues/192)) ([8f34e22](https://github.com/k2b-dev/cloud/commit/8f34e22db573839de5831992d8f9a5d6e00a9ed1))
* **ui:** keep a custom TextInput icon while the field is focused ([#199](https://github.com/k2b-dev/cloud/issues/199)) ([07f0a5b](https://github.com/k2b-dev/cloud/commit/07f0a5b08bfef32777a2cac2cd53a5b5d84b08db))
* **ui:** keep the TextInput focus ring visible over browser autofill ([#188](https://github.com/k2b-dev/cloud/issues/188)) ([714e658](https://github.com/k2b-dev/cloud/commit/714e6585b7bb5913afcebaa6605ac1875ff34bf5))
* **ui:** spin the pull-to-refresh indicator and calm the Mail search summary link ([#217](https://github.com/k2b-dev/cloud/issues/217)) ([ac77eb7](https://github.com/k2b-dev/cloud/commit/ac77eb7e98855eb3e146a8b4afcfabd4a03afbe8))

## [0.15.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.14.1...cloud-v0.15.0) (2026-09-23)


### Features

* **notebooks:** render diagrams with mermaid 12 ([#181](https://github.com/k2b-dev/cloud/issues/181)) ([5a41b0a](https://github.com/k2b-dev/cloud/commit/5a41b0a47537bae93daa3ddd26aa04c5014462db))


### Bug Fixes

* **cloud:** recover stalled live connections when a tab or network returns ([#184](https://github.com/k2b-dev/cloud/issues/184)) ([230c402](https://github.com/k2b-dev/cloud/commit/230c4026cf11cd353127664e1157b872c3f1cccb))
* **grids:** pluralise document counts and download mixed run results as a ZIP ([#183](https://github.com/k2b-dev/cloud/issues/183)) ([1bd5f10](https://github.com/k2b-dev/cloud/commit/1bd5f1009852b1dbb2a39c6dfcc252b4406501e7))
* **mail:** keep forwarded attachments and automations in their original order ([#180](https://github.com/k2b-dev/cloud/issues/180)) ([491972c](https://github.com/k2b-dev/cloud/commit/491972c0f65bc95b2823d61336ee160fef9af143))
* **mail:** list message attachments in their original order ([#185](https://github.com/k2b-dev/cloud/issues/185)) ([9ac2b00](https://github.com/k2b-dev/cloud/commit/9ac2b00bdf14b1a0e98932d0c4b1f14d80fad90e))
* page notifications, bases and telemetry with a stable order ([#182](https://github.com/k2b-dev/cloud/issues/182)) ([b04cffb](https://github.com/k2b-dev/cloud/commit/b04cffb535b244562ff5f29d6e5e044d7219852d))

## [0.14.1](https://github.com/k2b-dev/cloud/compare/cloud-v0.14.0...cloud-v0.14.1) (2026-09-23)


### Bug Fixes

* **mail:** show one aligned needs-action count per mailbox ([#176](https://github.com/k2b-dev/cloud/issues/176)) ([4239477](https://github.com/k2b-dev/cloud/commit/4239477c3f44ad5e21f1ed282df511b46d8d8e79)), closes [#175](https://github.com/k2b-dev/cloud/issues/175)

## [0.14.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.13.0...cloud-v0.14.0) (2026-09-23)


### Features

* **mail:** configure the contact directory in a dialog and through cld ([#173](https://github.com/k2b-dev/cloud/issues/173)) ([18c78db](https://github.com/k2b-dev/cloud/commit/18c78db2f5205eac6a31b13e47241dbebcf3d257))

## [0.13.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.12.0...cloud-v0.13.0) (2026-09-23)


### Features

* **notebooks:** share one Yjs log across notes so JetStream reservations stay constant ([#168](https://github.com/k2b-dev/cloud/issues/168)) ([977d1d2](https://github.com/k2b-dev/cloud/commit/977d1d2d0b91b53caa408f9f4d61db0876f06f05))


### Bug Fixes

* **pulse:** keep events from the last millisecond inside live query windows ([#171](https://github.com/k2b-dev/cloud/issues/171)) ([38ee659](https://github.com/k2b-dev/cloud/commit/38ee65959ee99ae28a9696d3b290479554958ec8))

## [0.12.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.11.0...cloud-v0.12.0) (2026-09-23)


### Features

* **cli:** load third-party application modules as plugins ([#135](https://github.com/k2b-dev/cloud/issues/135)) ([94607d4](https://github.com/k2b-dev/cloud/commit/94607d4906fbcf0c6e765a44dfa6931281b58da5)), closes [#123](https://github.com/k2b-dev/cloud/issues/123)
* **grids:** filter and sort the document catalog by origin and type ([#156](https://github.com/k2b-dev/cloud/issues/156)) ([8a245eb](https://github.com/k2b-dev/cloud/commit/8a245ebc744a3b509729333a2add0095190e2edf)), closes [#52](https://github.com/k2b-dev/cloud/issues/52)
* **release:** sign and verify the CLI checksums with Sigstore bundles ([#142](https://github.com/k2b-dev/cloud/issues/142)) ([4ac9a92](https://github.com/k2b-dev/cloud/commit/4ac9a922978548c055243bcfa69309f709a48ec4))


### Bug Fixes

* **ai:** explain which setting blocks removing a model profile ([#139](https://github.com/k2b-dev/cloud/issues/139)) ([45aafcd](https://github.com/k2b-dev/cloud/commit/45aafcd930bdab910bfba1904c9a988c0dd68ce1))
* **dev:** let every dev container write its SSR output ([#138](https://github.com/k2b-dev/cloud/issues/138)) ([3577fd0](https://github.com/k2b-dev/cloud/commit/3577fd018c53c77c8e11a9537bab3c39679d4dc7))
* **mail:** keep HTML messages stable and show allowed images ([#143](https://github.com/k2b-dev/cloud/issues/143)) ([a1c8442](https://github.com/k2b-dev/cloud/commit/a1c8442aa3ba65d46089535ab52231fcec38c077))
* **notebooks:** import Bun statically so the minified reindex runs ([#140](https://github.com/k2b-dev/cloud/issues/140)) ([ed9ba97](https://github.com/k2b-dev/cloud/commit/ed9ba97a17552768c7ebc0695f7f9142f78ee3c6))

## [0.11.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.10.0...cloud-v0.11.0) (2026-09-22)


### Features

* align Weather, Pulse, Venue, and Capabilities overviews as cards ([#130](https://github.com/k2b-dev/cloud/issues/130)) ([ce747fa](https://github.com/k2b-dev/cloud/commit/ce747fa0137ee0edc30cbdea6878d9f66edd4056))
* **grids:** show bases as the overview sidebar with a centered activity column ([#129](https://github.com/k2b-dev/cloud/issues/129)) ([45795c1](https://github.com/k2b-dev/cloud/commit/45795c1e4f076fa9a835c08b0c402e40bc81521f))
* **mail:** pull to refresh the conversation list ([#109](https://github.com/k2b-dev/cloud/issues/109)) ([ad3a5f4](https://github.com/k2b-dev/cloud/commit/ad3a5f4a6166138e4a27622578f5eeb3d625d5d1))
* **overview:** sidebar-first Mail and Notebooks overviews ([#125](https://github.com/k2b-dev/cloud/issues/125)) ([311972c](https://github.com/k2b-dev/cloud/commit/311972c0b8f642983422273891e79cdd1e6eb9fd))
* **spaces:** show spaces as the overview sidebar with a centered activity column ([#127](https://github.com/k2b-dev/cloud/issues/127)) ([79cb07e](https://github.com/k2b-dev/cloud/commit/79cb07e084c4ea8be3f489b80f9fe39f5ece55d7))
* **tools:** calm card overview with the shared page header ([#128](https://github.com/k2b-dev/cloud/issues/128)) ([d0234db](https://github.com/k2b-dev/cloud/commit/d0234dbc52fc4d62895bceeff6e99afea9be72b7))


### Bug Fixes

* **cli:** send an optional GitHub token with release metadata requests ([#124](https://github.com/k2b-dev/cloud/issues/124)) ([fcc64fa](https://github.com/k2b-dev/cloud/commit/fcc64face21a0d08896f441bf6c69b1a6a4bf3ca))

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
