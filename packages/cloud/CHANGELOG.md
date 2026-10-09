# Changelog

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
