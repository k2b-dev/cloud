# Changelog

## [0.13.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.12.0...npm-ui-v0.13.0) (2026-10-04)


### Features

* **core:** flatten the account pages ([#572](https://github.com/k2b-dev/cloud/issues/572)) ([deaf537](https://github.com/k2b-dev/cloud/commit/deaf537c25414d89785ef24407b839d880c49252))
* **notebooks:** preview attached files instead of only downloading them ([#574](https://github.com/k2b-dev/cloud/issues/574)) ([8c443eb](https://github.com/k2b-dev/cloud/commit/8c443eb73cde98ff26c98035d0ab15d7fc9f80c1))
* **ui:** share phone app building blocks with Cloud Login ([#591](https://github.com/k2b-dev/cloud/issues/591)) ([394af22](https://github.com/k2b-dev/cloud/commit/394af22d4053b7418481ee25beda9288b88d038b))


### Bug Fixes

* announce quiet confirmations in Spaces, confirm hidden completions with Undo, and keep create and edit dialogs open until saved ([#585](https://github.com/k2b-dev/cloud/issues/585)) ([0a40a67](https://github.com/k2b-dev/cloud/commit/0a40a675282a976597c0a6f5d406cecb3e5d45aa))
* give every detail panel section the same flat frame, comments included ([#592](https://github.com/k2b-dev/cloud/issues/592)) ([42e81a6](https://github.com/k2b-dev/cloud/commit/42e81a6a6d9ff36d01fda71b73ac23b5a423795c))
* **ui:** keep icons the same width while the icon font loads ([#581](https://github.com/k2b-dev/cloud/issues/581)) ([cb58bbc](https://github.com/k2b-dev/cloud/commit/cb58bbc157f8f838c442d4c06036701358ff27f5))

## [0.12.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.11.0...npm-ui-v0.12.0) (2026-10-03)


### Features

* **files:** open previews with the document title and no second frame ([#563](https://github.com/k2b-dev/cloud/issues/563)) ([79864a1](https://github.com/k2b-dev/cloud/commit/79864a1d21e4e11db9ae22545ed09651588c9e5e))
* **files:** show every upload in one calm list with the total progress ([#533](https://github.com/k2b-dev/cloud/issues/533)) ([5100c3e](https://github.com/k2b-dev/cloud/commit/5100c3eb32c1d7fa98f13ef781aa1413c771ff4f))
* **notebooks:** let admins reserve deleting notes for themselves ([#552](https://github.com/k2b-dev/cloud/issues/552)) ([53c89c1](https://github.com/k2b-dev/cloud/commit/53c89c153079fb43b99b382916b8897558619fe2))
* **spaces:** show blockers, properties and who is working at a glance ([#551](https://github.com/k2b-dev/cloud/issues/551)) ([7348cf8](https://github.com/k2b-dev/cloud/commit/7348cf8d8088e16f5a5d20d56c2b2fb7635110b6))
* **ui:** calmer Markdown tables, quotes and code ([#561](https://github.com/k2b-dev/cloud/issues/561)) ([666ebae](https://github.com/k2b-dev/cloud/commit/666ebae2669bcc2054ed964dab64231464ab54e5))
* **ui:** give every surface a single frame ([#541](https://github.com/k2b-dev/cloud/issues/541)) ([9d613ed](https://github.com/k2b-dev/cloud/commit/9d613edf6afd047fb0f56c95bf0e02d7ae691f59))
* **ui:** group dialog sections without frames ([#558](https://github.com/k2b-dev/cloud/issues/558)) ([e6ec679](https://github.com/k2b-dev/cloud/commit/e6ec67959355bbca8c296b1cd64d76714dc9a402))
* **ui:** show toasts as one calm line ([#536](https://github.com/k2b-dev/cloud/issues/536)) ([8b3b358](https://github.com/k2b-dev/cloud/commit/8b3b358ee3c627e5b58cd037d7cee3bbb8c5f692))


### Bug Fixes

* **ui:** keep dialog headers in view and apply the code and table styles meant for previews ([#532](https://github.com/k2b-dev/cloud/issues/532)) ([cc93131](https://github.com/k2b-dev/cloud/commit/cc931312f21e7b11d05528c1a418c8072bd0c35a))
* **ui:** keep toasts timing out after a held control leaves the page ([#555](https://github.com/k2b-dev/cloud/issues/555)) ([e191790](https://github.com/k2b-dev/cloud/commit/e191790f56a3c5a67313d5df19e70f8bc4c4c099))

## [0.11.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.10.0...npm-ui-v0.11.0) (2026-10-01)


### Features

* **mail:** show a quick look card when hovering a conversation ([#517](https://github.com/k2b-dev/cloud/issues/517)) ([a8402c8](https://github.com/k2b-dev/cloud/commit/a8402c8ceac8d54960f13d9d1145542eee3e0a46))
* **notebooks:** hide the navigation completely for focused writing ([#520](https://github.com/k2b-dev/cloud/issues/520)) ([e78fd79](https://github.com/k2b-dev/cloud/commit/e78fd797e6d7e5a190fa3906bf4796a7308260a5))

## [0.10.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.9.1...npm-ui-v0.10.0) (2026-10-01)


### ⚠ BREAKING CHANGES

* **assistant:** the exported browser-safe type `AiChatQuotaSnapshot` and `GET /api/ai/quotas` (and `getAiChatQuotas()`) no longer carry money: `unit`, `limit`, `used`, `input`, `output`, and `estimated` are gone. Each balance is now `{ scope, unlimited, usedPercent, resetsAt }`. `usedPercent` is a whole number from 0 to 100, reaches 100 only when the allowance is used up, and is `null` when the allowance is unlimited or cannot be measured. Administrators still configure allowances in money in the admin settings, and the administrator endpoints keep amounts.

### Features

* **assistant:** show chat usage as a quiet ring without money ([#486](https://github.com/k2b-dev/cloud/issues/486)) ([27f6b77](https://github.com/k2b-dev/cloud/commit/27f6b7721c44d5328387c5cdfa99b1473f22a84a))
* **ui:** add a hover preview card that opens beside its anchor ([#516](https://github.com/k2b-dev/cloud/issues/516)) ([3a05dd3](https://github.com/k2b-dev/cloud/commit/3a05dd3ec8528766bcee25cd8f49f553b19b540a))
* **ui:** keep focus rings visible inside clipping containers ([#484](https://github.com/k2b-dev/cloud/issues/484)) ([b5051f9](https://github.com/k2b-dev/cloud/commit/b5051f99cd6238c12cd7f99aac1e25803a488b8a))


### Bug Fixes

* **ui:** give icon-only controls a tooltip with their label ([#497](https://github.com/k2b-dev/cloud/issues/497)) ([f3119bc](https://github.com/k2b-dev/cloud/commit/f3119bc687158c0209699273e77798ab08b53664))
* **ui:** keep a just-opened context menu open ([#512](https://github.com/k2b-dev/cloud/issues/512)) ([591c840](https://github.com/k2b-dev/cloud/commit/591c8409414a9a14df0fd224d4fb28db97a3086e))
* **ui:** keep field errors red inside dialog sections ([#501](https://github.com/k2b-dev/cloud/issues/501)) ([6ee0b0a](https://github.com/k2b-dev/cloud/commit/6ee0b0a8d6494797b375e397bc2069fed82bf2ec))
* **ui:** keep multi-line fields with a description inside form dialogs ([#508](https://github.com/k2b-dev/cloud/issues/508)) ([ef6738f](https://github.com/k2b-dev/cloud/commit/ef6738f4e1678bb5cee9a3b8022797c3f1c129e6))
* **ui:** keep the tab list from scrolling vertically ([#500](https://github.com/k2b-dev/cloud/issues/500)) ([fac3137](https://github.com/k2b-dev/cloud/commit/fac3137141f37871555de2381ec4349f1708f0cf))
* **ui:** return focus without a ring when a pointer opened the overlay ([#496](https://github.com/k2b-dev/cloud/issues/496)) ([5be160b](https://github.com/k2b-dev/cloud/commit/5be160bbc2e62078b0da6bb6ac181d2677c1c7bc))
* **ui:** reveal the sidebar preview button without shrinking the item label ([#511](https://github.com/k2b-dev/cloud/issues/511)) ([8f0ffa5](https://github.com/k2b-dev/cloud/commit/8f0ffa5a6463705d13bf9328e9f9545426ee4f08))
* **ui:** show the loading placeholder while a PDF preview loads ([#506](https://github.com/k2b-dev/cloud/issues/506)) ([b94acfd](https://github.com/k2b-dev/cloud/commit/b94acfdbab3b16bf78c9a2be23484996bd55bd05))
* **ui:** size menus to their content so every label is readable ([#503](https://github.com/k2b-dev/cloud/issues/503)) ([2f38dae](https://github.com/k2b-dev/cloud/commit/2f38daed413d962715fe754be8cf8ebd92709b30))

## [0.9.1](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.9.0...npm-ui-v0.9.1) (2026-09-30)


### Bug Fixes

* **deps:** move to @k2b/stdlib 0.27.0 and show dates in each locale's order ([#472](https://github.com/k2b-dev/cloud/issues/472)) ([163ace1](https://github.com/k2b-dev/cloud/commit/163ace136dd89d587a700d579df9a42502d71f60))
* **deps:** move to marked 18 ([#474](https://github.com/k2b-dev/cloud/issues/474)) ([5dd1d3a](https://github.com/k2b-dev/cloud/commit/5dd1d3aca52b03744fc0059fc5619a32e9972143)), closes [#463](https://github.com/k2b-dev/cloud/issues/463)
* **ui:** keep iPhones from zooming when a text field takes focus ([#477](https://github.com/k2b-dev/cloud/issues/477)) ([8b480ec](https://github.com/k2b-dev/cloud/commit/8b480ec6e27b51e4cf3c445cee2e23509f57d197))
* **ui:** keep the CheckboxCard input inside its card when lists scroll ([#445](https://github.com/k2b-dev/cloud/issues/445)) ([e466802](https://github.com/k2b-dev/cloud/commit/e466802ee642192ab5035f53c78c54b5d0f1c2ac)), closes [#404](https://github.com/k2b-dev/cloud/issues/404)
* **ui:** make dropdown and menu items finger-sized on phones ([#448](https://github.com/k2b-dev/cloud/issues/448)) ([8c843b3](https://github.com/k2b-dev/cloud/commit/8c843b31c93bf5a92c32177233fe973e9cfe77c7))
* **ui:** scroll the settings panel, not the dialog frame, when a hidden control takes focus ([#473](https://github.com/k2b-dev/cloud/issues/473)) ([849f439](https://github.com/k2b-dev/cloud/commit/849f439b2a11ee988e43eeb2668e83ffa9ef8a70))

## [0.9.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.8.0...npm-ui-v0.9.0) (2026-09-29)


### Features

* **files:** open a previewed PDF in a new tab at a stable address ([#415](https://github.com/k2b-dev/cloud/issues/415)) ([6cdb6c9](https://github.com/k2b-dev/cloud/commit/6cdb6c9351a04300f8983c25d77a5827341f0d11))


### Bug Fixes

* **cloud:** keep Tailwind utilities above the property fallback layer in older browsers ([#426](https://github.com/k2b-dev/cloud/issues/426)) ([6729676](https://github.com/k2b-dev/cloud/commit/672967631f061eaee49ca8f87379801568ece666))
* **files:** download or open a previewed PDF in a new tab ([#392](https://github.com/k2b-dev/cloud/issues/392)) ([ce978d1](https://github.com/k2b-dev/cloud/commit/ce978d1de3b2b60cc414a30308bc344577c52617))
* **files:** offer PDF actions only for PDFs and show loading instead of an error before the preview starts ([#434](https://github.com/k2b-dev/cloud/issues/434)) ([08e5c47](https://github.com/k2b-dev/cloud/commit/08e5c478bda33335f324d6f9033a1ba86a1d960f))
* **notebooks:** keep phone menu folds and settings categories usable on narrow screens ([#416](https://github.com/k2b-dev/cloud/issues/416)) ([4bedff0](https://github.com/k2b-dev/cloud/commit/4bedff059361d3f711e60d94a4f4fad5ef85da29))
* **ui:** give toast actions and close buttons finger-sized touch targets ([#435](https://github.com/k2b-dev/cloud/issues/435)) ([31174a7](https://github.com/k2b-dev/cloud/commit/31174a75b6b640366f5672ec19dde457ab353ae6))
* **ui:** keep phone header and settings close touch targets finger-sized without overlap ([#424](https://github.com/k2b-dev/cloud/issues/424)) ([9024d79](https://github.com/k2b-dev/cloud/commit/9024d7948687182472381dd1063301a975ae02a3))
* **ui:** keep phone tap areas clear of neighbouring controls and give the header Home link a finger-sized target ([#433](https://github.com/k2b-dev/cloud/issues/433)) ([b0be346](https://github.com/k2b-dev/cloud/commit/b0be34624d7840f0f4e87a4691958b9a47b899d5))
* **ui:** make compact controls, toasts and the detail panel work on phones ([#419](https://github.com/k2b-dev/cloud/issues/419)) ([fa92fd0](https://github.com/k2b-dev/cloud/commit/fa92fd081d435764f5247d2675ded32d84b20993))
* **ui:** make detail panel action rows finger-sized on phones ([#437](https://github.com/k2b-dev/cloud/issues/437)) ([9f68b99](https://github.com/k2b-dev/cloud/commit/9f68b99b0c6007547a66be4d2df99f3774df7219))
* **ui:** show built-in confirmation, toast and form messages in the reader's language ([#425](https://github.com/k2b-dev/cloud/issues/425)) ([8545490](https://github.com/k2b-dev/cloud/commit/8545490d8868491722bf299fe808336e0f0878d6))
* **venue:** polish schedule, feedback, monitor and public page details on desktop and phones ([#428](https://github.com/k2b-dev/cloud/issues/428)) ([72c9452](https://github.com/k2b-dev/cloud/commit/72c945262ab3effc4a1b50a0d2dbe0a702cb0629))

## [0.8.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.7.0...npm-ui-v0.8.0) (2026-09-28)


### Features

* **ui:** add an inline Placeholder for empty lists and use it in empty notebooks ([#365](https://github.com/k2b-dev/cloud/issues/365)) ([792c256](https://github.com/k2b-dev/cloud/commit/792c256f2798d9ac3efbe237bffbf24331617ed1)), closes [#359](https://github.com/k2b-dev/cloud/issues/359)


### Bug Fixes

* **ui:** load more table rows when the page scrolls ([#377](https://github.com/k2b-dev/cloud/issues/377)) ([a9d4e6d](https://github.com/k2b-dev/cloud/commit/a9d4e6dfca2971fb154ca5470ddde25c5dbdc0f6))
* **ui:** show how many selections a narrow multi-select hides ([#357](https://github.com/k2b-dev/cloud/issues/357)) ([38c1b2c](https://github.com/k2b-dev/cloud/commit/38c1b2cc7e2102e3de553dfd588bf5187cc45638))

## [0.7.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.6.3...npm-ui-v0.7.0) (2026-09-27)


### Features

* **assistant:** delete chat files from the Files list ([#347](https://github.com/k2b-dev/cloud/issues/347)) ([5246601](https://github.com/k2b-dev/cloud/commit/52466014b27cc5405041ecfe4a8c01fe9709483a))
* **spaces:** group the item detail panel by planning, content, work, and context ([#325](https://github.com/k2b-dev/cloud/issues/325)) ([38436fa](https://github.com/k2b-dev/cloud/commit/38436fac87380971530c6b7b1471f299da6667ea)), closes [#322](https://github.com/k2b-dev/cloud/issues/322)


### Bug Fixes

* **ui:** keep sidebar row menus open while the pointer moves into them ([#338](https://github.com/k2b-dev/cloud/issues/338)) ([fdae52d](https://github.com/k2b-dev/cloud/commit/fdae52de7bbedbb5fbfed050d37cc7ffdd6398f7))
* **ui:** preview PDFs from loaded bytes when no inline URL exists ([#341](https://github.com/k2b-dev/cloud/issues/341)) ([1f15850](https://github.com/k2b-dev/cloud/commit/1f158501cb1d84dacc81db58abf6a92d2a0590f7))
* **ui:** reveal a nav tree row's actions only for that row ([#343](https://github.com/k2b-dev/cloud/issues/343)) ([f039ab2](https://github.com/k2b-dev/cloud/commit/f039ab2ba1e99226d2746c86582cc8c3b415c5e5))

## [0.6.3](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.6.2...npm-ui-v0.6.3) (2026-09-26)


### Bug Fixes

* **core:** polish account pages and settings source labels ([#259](https://github.com/k2b-dev/cloud/issues/259)) ([c73dbf8](https://github.com/k2b-dev/cloud/commit/c73dbf80b3bd345b8aa5036ef0f5d99f3fc51d5a))

## [0.6.2](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.6.1...npm-ui-v0.6.2) (2026-09-26)


### Bug Fixes

* **ui:** open bottom sheets without a focus ring and extend the footer into the safe area ([#243](https://github.com/k2b-dev/cloud/issues/243)) ([fa82d9b](https://github.com/k2b-dev/cloud/commit/fa82d9bb2df4f310287df67f60f8048e3bc8d804))

## [0.6.1](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.6.0...npm-ui-v0.6.1) (2026-09-25)


### Bug Fixes

* **ui:** localize default toast titles ([#239](https://github.com/k2b-dev/cloud/issues/239)) ([9bcf6e9](https://github.com/k2b-dev/cloud/commit/9bcf6e90b02f7da8d7a123977cb3f45a2079befe))

## [0.6.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.5.1...npm-ui-v0.6.0) (2026-09-24)


### Features

* **notebooks:** zoom, pan, and open Mermaid diagrams fullscreen ([#194](https://github.com/k2b-dev/cloud/issues/194)) ([b88ac25](https://github.com/k2b-dev/cloud/commit/b88ac253479f3ba01676383fe06107cd31813614))


### Bug Fixes

* **ui:** align entity search results left with the action on the right ([#192](https://github.com/k2b-dev/cloud/issues/192)) ([8f34e22](https://github.com/k2b-dev/cloud/commit/8f34e22db573839de5831992d8f9a5d6e00a9ed1))
* **ui:** keep a custom TextInput icon while the field is focused ([#199](https://github.com/k2b-dev/cloud/issues/199)) ([07f0a5b](https://github.com/k2b-dev/cloud/commit/07f0a5b08bfef32777a2cac2cd53a5b5d84b08db))
* **ui:** keep the TextInput focus ring visible over browser autofill ([#188](https://github.com/k2b-dev/cloud/issues/188)) ([714e658](https://github.com/k2b-dev/cloud/commit/714e6585b7bb5913afcebaa6605ac1875ff34bf5))
* **ui:** spin the pull-to-refresh indicator and calm the Mail search summary link ([#217](https://github.com/k2b-dev/cloud/issues/217)) ([ac77eb7](https://github.com/k2b-dev/cloud/commit/ac77eb7e98855eb3e146a8b4afcfabd4a03afbe8))

## [0.5.1](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.5.0...npm-ui-v0.5.1) (2026-09-23)


### Bug Fixes

* **mail:** show one aligned needs-action count per mailbox ([#176](https://github.com/k2b-dev/cloud/issues/176)) ([4239477](https://github.com/k2b-dev/cloud/commit/4239477c3f44ad5e21f1ed282df511b46d8d8e79)), closes [#175](https://github.com/k2b-dev/cloud/issues/175)

## [0.5.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.4.2...npm-ui-v0.5.0) (2026-09-22)


### Features

* align Weather, Pulse, Venue, and Capabilities overviews as cards ([#130](https://github.com/k2b-dev/cloud/issues/130)) ([ce747fa](https://github.com/k2b-dev/cloud/commit/ce747fa0137ee0edc30cbdea6878d9f66edd4056))
* **mail:** pull to refresh the conversation list ([#109](https://github.com/k2b-dev/cloud/issues/109)) ([ad3a5f4](https://github.com/k2b-dev/cloud/commit/ad3a5f4a6166138e4a27622578f5eeb3d625d5d1))
* **overview:** sidebar-first Mail and Notebooks overviews ([#125](https://github.com/k2b-dev/cloud/issues/125)) ([311972c](https://github.com/k2b-dev/cloud/commit/311972c0b8f642983422273891e79cdd1e6eb9fd))
* **tools:** calm card overview with the shared page header ([#128](https://github.com/k2b-dev/cloud/issues/128)) ([d0234db](https://github.com/k2b-dev/cloud/commit/d0234dbc52fc4d62895bceeff6e99afea9be72b7))

## [0.4.2](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.4.1...npm-ui-v0.4.2) (2026-09-22)


### Bug Fixes

* **ui:** align paired field controls regardless of description length ([#110](https://github.com/k2b-dev/cloud/issues/110)) ([6ddad3e](https://github.com/k2b-dev/cloud/commit/6ddad3ed5267353c72267880a2f2eb05657acd7b)), closes [#92](https://github.com/k2b-dev/cloud/issues/92)
* **ui:** show dialog and sheet focus rings only for keyboard focus ([#103](https://github.com/k2b-dev/cloud/issues/103)) ([98a8ae7](https://github.com/k2b-dev/cloud/commit/98a8ae74a9c52db080d0fd8049ddb4b07ad6e1c7)), closes [#102](https://github.com/k2b-dev/cloud/issues/102)

## [0.4.1](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.4.0...npm-ui-v0.4.1) (2026-09-22)


### Bug Fixes

* **core:** allow decimal AI model prices ([#75](https://github.com/k2b-dev/cloud/issues/75)) ([603ab9e](https://github.com/k2b-dev/cloud/commit/603ab9e278a6ca6660e888138a5421db98f5ad75)), closes [#72](https://github.com/k2b-dev/cloud/issues/72)
* **ui:** keep check and switch inputs inside their label ([#71](https://github.com/k2b-dev/cloud/issues/71)) ([3a451c0](https://github.com/k2b-dev/cloud/commit/3a451c04da7741f3ba49c3e63ae69d4fb9015cb2)), closes [#63](https://github.com/k2b-dev/cloud/issues/63)
* **ui:** keep the workspace sidebar scroll position across navigations ([#81](https://github.com/k2b-dev/cloud/issues/81)) ([fe52d9d](https://github.com/k2b-dev/cloud/commit/fe52d9dedb6555b40a009e44ebbc57faf228176e)), closes [#78](https://github.com/k2b-dev/cloud/issues/78)

## [0.4.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.3.0...npm-ui-v0.4.0) (2026-09-21)


### Features

* adopt a release train with gated CI and one configuration model ([7fa46ac](https://github.com/k2b-dev/cloud/commit/7fa46ac88f7af9fe5c58152beae2bda5180fcd55))
