# Changelog

## [0.33.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.32.0...npm-ui-v0.33.0) (2026-10-24)


### Features

* **apps:** declare access rules for every built-in application ([#1852](https://github.com/k2b-dev/cloud/issues/1852)) ([4cf7b8e](https://github.com/k2b-dev/cloud/commit/4cf7b8eca70615fccc6f10ccbd7e0f2782804ab0))
* **chat:** threads with All threads, replies, and a thread column from 1800 px ([#1856](https://github.com/k2b-dev/cloud/issues/1856)) ([470f6b4](https://github.com/k2b-dev/cloud/commit/470f6b481af518e0e566a56a9a7a58ee73c3bb17))
* **pwa:** the Cloud app uses iPad and monitor widths, and Spaces opens a task beside the list ([#1802](https://github.com/k2b-dev/cloud/issues/1802)) ([c1026c1](https://github.com/k2b-dev/cloud/commit/c1026c1452a9cfef0545657d24be447b59e1d3e9)), closes [#1104](https://github.com/k2b-dev/cloud/issues/1104)

## [0.32.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.31.0...npm-ui-v0.32.0) (2026-10-23)


### Features

* **cloud:** keep the shell and panel during in-app page changes ([#1653](https://github.com/k2b-dev/cloud/issues/1653)) ([7dc9247](https://github.com/k2b-dev/cloud/commit/7dc92472f4eada6534a6a55c4e9bef3d0e90168d))
* **core:** provide budgeted maps and editable routes through Geoapify EU ([#1703](https://github.com/k2b-dev/cloud/issues/1703)) ([90f996d](https://github.com/k2b-dev/cloud/commit/90f996d801fa654f14e0189d7639a30555b68aeb))
* **mail:** keep search, filters and reader actions in the workspace head ([#1665](https://github.com/k2b-dev/cloud/issues/1665)) ([c4956a5](https://github.com/k2b-dev/cloud/commit/c4956a5096fc3fd6d7016dd3f4359dd219d7232e))
* **mail:** retain the workspace when switching mailbox contexts ([#1659](https://github.com/k2b-dev/cloud/issues/1659)) ([660704b](https://github.com/k2b-dev/cloud/commit/660704b93f17f8c242704d461ea65f1577052b20))
* **pulse:** ask Pulse in SQL from the console, the CLI and the Assistant ([#1662](https://github.com/k2b-dev/cloud/issues/1662)) ([a74c42c](https://github.com/k2b-dev/cloud/commit/a74c42cc0cb09acc9bf828aba8f99f4cc8278d6d))
* **ui:** explain rich selections with optional previews ([#1655](https://github.com/k2b-dev/cloud/issues/1655)) ([4b03a10](https://github.com/k2b-dev/cloud/commit/4b03a1040eba27660dabf23c673cfc6ec2551d8a))
* **ui:** keep workspace controls reachable across layouts ([#1661](https://github.com/k2b-dev/cloud/issues/1661)) ([9a53dff](https://github.com/k2b-dev/cloud/commit/9a53dff2d06dd60749e15b08dc5056570652b0ca))


### Bug Fixes

* **deps:** remove vulnerable runtime and build dependency copies ([#1682](https://github.com/k2b-dev/cloud/issues/1682)) ([fba8cb9](https://github.com/k2b-dev/cloud/commit/fba8cb99b44b4684f74ff00a91e6e61237e17c9c))
* **ui:** await phone picker readiness before accessibility audits ([#1668](https://github.com/k2b-dev/cloud/issues/1668)) ([3fe4f84](https://github.com/k2b-dev/cloud/commit/3fe4f84c1a41dbb74d9702f1c3d34cc5b36ee8ee))
* **ui:** guard formatted chart values when copying ([#1729](https://github.com/k2b-dev/cloud/issues/1729)) ([ec5a399](https://github.com/k2b-dev/cloud/commit/ec5a399faaf3aa14dff38702661065b38379bd90))
* **ui:** keep phone workspace heads with their list pane ([#1663](https://github.com/k2b-dev/cloud/issues/1663)) ([9ac019e](https://github.com/k2b-dev/cloud/commit/9ac019e917a515e356102a01e7bf9753193d4cc6))
* **ui:** refine workspace Details presentation and focus ([#1672](https://github.com/k2b-dev/cloud/issues/1672)) ([ceec88c](https://github.com/k2b-dev/cloud/commit/ceec88c68d11cf861614ee7a71e4c532bcb3f631))
* **ui:** round card corners on Core Administration and every app when the sidebar is hidden ([#1644](https://github.com/k2b-dev/cloud/issues/1644)) ([e44abea](https://github.com/k2b-dev/cloud/commit/e44abeaf066dfa4404aaa56f3a6e7dbaf68ce36c))
* **ui:** settle theme transitions before RichSelect contrast audits ([#1664](https://github.com/k2b-dev/cloud/issues/1664)) ([658b226](https://github.com/k2b-dev/cloud/commit/658b226b0db4a0e8bdc29e9452f600fc2827d99f))
* **ui:** show a consistent resize shadow on every resizable edge ([#1652](https://github.com/k2b-dev/cloud/issues/1652)) ([8f99273](https://github.com/k2b-dev/cloud/commit/8f9927348d0466d5e09088c5fb93498c966aa8a4))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @k2b/ssr bumped from 0.19.0 to 0.20.0
  * peerDependencies
    * @k2b/ssr bumped from ^0.12.0 || ^0.13.0 || ^0.14.0 || ^0.15.0 || ^0.16.0 || ^0.17.0 || ^0.18.0 || ^0.19.0 || ^0.20.0 to ^0.20.0

## [0.31.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.30.0...npm-ui-v0.31.0) (2026-10-20)


### Features

* **assistant:** show 'Wartet auf dich' above the composer and a dot on chats with an open question ([#1579](https://github.com/k2b-dev/cloud/issues/1579)) ([b16523b](https://github.com/k2b-dev/cloud/commit/b16523b8877df50c6dc5a8eda22ad7a1072c6d30))
* **mail:** a calm reader on wide windows, three-line rows, and reader actions that move into '…' when space is tight ([#1635](https://github.com/k2b-dev/cloud/issues/1635)) ([31d81f0](https://github.com/k2b-dev/cloud/commit/31d81f0791dfccdcfa6a236544428ab0c8075491)), closes [#1545](https://github.com/k2b-dev/cloud/issues/1545) [#1467](https://github.com/k2b-dev/cloud/issues/1467)
* **ssr:** give history one owner, so Back and Forward swap between server pages and islands keep their own entries ([#1616](https://github.com/k2b-dev/cloud/issues/1616)) ([50192a8](https://github.com/k2b-dev/cloud/commit/50192a883d417c6136659de59e86cf9f320719cf))
* **ui:** a flat Cloud map style in light and dark, built from the @k2b/ui tokens, with self-served label glyphs ([#1630](https://github.com/k2b-dev/cloud/issues/1630)) ([9c8ae1f](https://github.com/k2b-dev/cloud/commit/9c8ae1f9e49d604122a5945f1a131308dbeda4e6))
* **ui:** MapView shows numbered places, routes and areas on a flat map that loads only when visible ([#1611](https://github.com/k2b-dev/cloud/issues/1611)) ([12367d7](https://github.com/k2b-dev/cloud/commit/12367d7a10e66e7c4fe21f3d881a4b179d01a3c0))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @k2b/ssr bumped from 0.18.0 to 0.19.0
  * peerDependencies
    * @k2b/ssr bumped from ^0.12.0 || ^0.13.0 || ^0.14.0 || ^0.15.0 || ^0.16.0 || ^0.17.0 || ^0.18.0 || ^0.19.0 to ^0.19.0

## [0.30.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.29.0...npm-ui-v0.30.0) (2026-10-20)


### Features

* **assistant:** show recently sent references first in the slash menu ([#1531](https://github.com/k2b-dev/cloud/issues/1531)) ([5082c87](https://github.com/k2b-dev/cloud/commit/5082c870415bb020e3d7db161aa342dcda119c28))
* chosen views, ranges and filters use tabs, segments and chips instead of filled primary buttons ([#1578](https://github.com/k2b-dev/cloud/issues/1578)) ([55490a1](https://github.com/k2b-dev/cloud/commit/55490a149441e533ee285462d75936e8620036cb))
* **cloud:** open app commands from the slash menu and return to the chat ([#1521](https://github.com/k2b-dev/cloud/issues/1521)) ([397bda5](https://github.com/k2b-dev/cloud/commit/397bda59590ee28289cdbb1e59827f2e6bf38da5))
* **cloud:** show Assistant questions as one sentence with the thing itself ([#1556](https://github.com/k2b-dev/cloud/issues/1556)) ([a1d1389](https://github.com/k2b-dev/cloud/commit/a1d13895389a010514bd757a917edb30c0e94375))
* **spaces:** task deadlines are all-day by default, a time is optional ([#1432](https://github.com/k2b-dev/cloud/issues/1432)) ([a4db766](https://github.com/k2b-dev/cloud/commit/a4db766d53e7b6439ebe57582e14abbf43216c95))
* **ssr:** mount islands in inserted content, and on removal dispose them and close open dialogs ([#1570](https://github.com/k2b-dev/cloud/issues/1570)) ([1c176dd](https://github.com/k2b-dev/cloud/commit/1c176dd731b4854629e5bd39bf7737f32c04e8fe)), closes [#1560](https://github.com/k2b-dev/cloud/issues/1560)
* **ui:** a minimal table, empty and error states without a box, and a one-time hint for moved paths ([#1508](https://github.com/k2b-dev/cloud/issues/1508)) ([c757e0d](https://github.com/k2b-dev/cloud/commit/c757e0d3c32e576eb9f3da8d9aa4ae07a7a0411d))
* **ui:** app and shell chrome follow the app host beside the panel, and watchAppHostWidth for scripts ([#1482](https://github.com/k2b-dev/cloud/issues/1482)) ([8208c75](https://github.com/k2b-dev/cloud/commit/8208c759021307bf6e202d9460985e6c35c98582))
* **ui:** calendars shade the weekend, and one click picks a one-day range ([#1479](https://github.com/k2b-dev/cloud/issues/1479)) ([766c757](https://github.com/k2b-dev/cloud/commit/766c757e6a14f88b07f84f38d8d089dc0bb4ca06))
* **ui:** darker secondary text and the C Kontrast type scale ([#1415](https://github.com/k2b-dev/cloud/issues/1415)) ([0e14415](https://github.com/k2b-dev/cloud/commit/0e14415e10d8f0d1051ff8702b9e4b57aefbb5ea))
* **ui:** navigation labels that do not fit fade out instead of ending in an ellipsis ([#1480](https://github.com/k2b-dev/cloud/issues/1480)) ([7b0b36b](https://github.com/k2b-dev/cloud/commit/7b0b36b958d289f5592579d0ca070e3a0ba08b53))
* **ui:** one white workspace surface, and a detail that keeps Main's minimum and waits behind Details ([#1468](https://github.com/k2b-dev/cloud/issues/1468)) ([e497a3d](https://github.com/k2b-dev/cloud/commit/e497a3d0c72e6613ece7904aedd35609d7a1ec8b))
* **ui:** open the slash list from + with a search field ([#1540](https://github.com/k2b-dev/cloud/issues/1540)) ([5fe13bf](https://github.com/k2b-dev/cloud/commit/5fe13bf02000c44f92d685650b986c731a6e37e6))
* **ui:** selected rows and navigation carry the app color ([#1429](https://github.com/k2b-dev/cloud/issues/1429)) ([6bcb69c](https://github.com/k2b-dev/cloud/commit/6bcb69c5069116e46a1442ee8c7ea5e528e5ee86))
* **ui:** step rows open at their count, and question cards follow the chat's width ([#1532](https://github.com/k2b-dev/cloud/issues/1532)) ([747a852](https://github.com/k2b-dev/cloud/commit/747a8520946eb76d59c13967df5dfc7617a77393))
* **ui:** views as tabs and filters as chips in one head row that wraps by the workspace's width, with the platform rule 'objects left, views in the head' ([#1493](https://github.com/k2b-dev/cloud/issues/1493)) ([24f6273](https://github.com/k2b-dev/cloud/commit/24f627300b4edda049db22fb300740d762344966))


### Bug Fixes

* **cloud:** depend on @k2b/stdlib 0.30.0 ([#1500](https://github.com/k2b-dev/cloud/issues/1500)) ([2342456](https://github.com/k2b-dev/cloud/commit/2342456df0ae93fa79393a722f5586f39a9042a4))
* **cloud:** mix the selected navigation fill over the white sidebar it sits on ([#1512](https://github.com/k2b-dev/cloud/issues/1512)) ([a45fb98](https://github.com/k2b-dev/cloud/commit/a45fb98f0527483c77fef99f3e11916d995598bc))
* **ui:** one color and selection guide for Cloud apps, with live states ([#1591](https://github.com/k2b-dev/cloud/issues/1591)) ([540a005](https://github.com/k2b-dev/cloud/commit/540a005f1f6255fb2a7204e64cd3bdc1c4bec420))
* **ui:** view tabs keep their full labels on phones, and the strip scrolls sideways to the current view ([#1569](https://github.com/k2b-dev/cloud/issues/1569)) ([2d496b7](https://github.com/k2b-dev/cloud/commit/2d496b70c41f12d2ef463db3ccabe1fff544f50d))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @k2b/ssr bumped from 0.17.0 to 0.18.0
  * peerDependencies
    * @k2b/ssr bumped from ^0.12.0 || ^0.13.0 || ^0.14.0 || ^0.15.0 || ^0.16.0 || ^0.17.0 || ^0.18.0 to ^0.18.0

## [0.29.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.28.0...npm-ui-v0.29.0) (2026-10-18)


### Features

* **ai:** say which routine stopped and why ([#1448](https://github.com/k2b-dev/cloud/issues/1448)) ([da8fc05](https://github.com/k2b-dev/cloud/commit/da8fc0511451965593d7e530e6c4569cdb764a50))
* **cloud:** a panel beside every app that any app can offer with `panel` in defineApp ([#1439](https://github.com/k2b-dev/cloud/issues/1439)) ([53bf2e7](https://github.com/k2b-dev/cloud/commit/53bf2e77757ac8d3211ee4d54f312fb90d3665c1))
* **cloud:** insert notes, contacts, tasks and other Cloud content from the slash menu ([#1370](https://github.com/k2b-dev/cloud/issues/1370)) ([d2514a7](https://github.com/k2b-dev/cloud/commit/d2514a7133277868624074cbbdf66812ed80a912))
* **cloud:** soft shell on iPad and phone: rail in an app-gradient container and the app as a card (I5), a soft card on the gradient and a floating bottom bar (P5) ([#1419](https://github.com/k2b-dev/cloud/issues/1419)) ([99e9e3e](https://github.com/k2b-dev/cloud/commit/99e9e3e626967cf08ff4020bbe09b53d2f07b79a))
* **spaces:** react to items with emoji through the API, capabilities and cld ([#1362](https://github.com/k2b-dev/cloud/issues/1362)) ([fc55f73](https://github.com/k2b-dev/cloud/commit/fc55f73496f2a838cbab908f733d249b804df53d))
* **ui:** add chat questions with typed chips and an object preview ([#1412](https://github.com/k2b-dev/cloud/issues/1412)) ([899b7bf](https://github.com/k2b-dev/cloud/commit/899b7bfe5a8dd81b32ee698d6ff44ead7c7e27e7))
* **ui:** app and file-type icons sit in a soft chip of their color ([#1451](https://github.com/k2b-dev/cloud/issues/1451)) ([4589907](https://github.com/k2b-dev/cloud/commit/45899070079ba3e5321d51c2b5956c7fe208f510))
* **ui:** every Chart shows tooltips by default ([#1357](https://github.com/k2b-dev/cloud/issues/1357)) ([a2605a0](https://github.com/k2b-dev/cloud/commit/a2605a065473f9824463fc45cbe8129c9ff2e9b2))
* **ui:** lay out workspaces by the width their host gives them and let a detail that does not fit wait ([#1380](https://github.com/k2b-dev/cloud/issues/1380)) ([a57ba45](https://github.com/k2b-dev/cloud/commit/a57ba45bac687e335b96d134e0ea2c848c33cd85))
* **ui:** one drag and drop for rows, tasks, events and paragraphs, with a keyboard and menu path ([#1376](https://github.com/k2b-dev/cloud/issues/1376)) ([682e08b](https://github.com/k2b-dev/cloud/commit/682e08babc1500275b413e30336a9a7a9b474ffb)), closes [#1255](https://github.com/k2b-dev/cloud/issues/1255)
* **ui:** show an overview's objects as chips on iPad and phone instead of the grey block, with an All sheet and a phone title menu ([#1441](https://github.com/k2b-dev/cloud/issues/1441)) ([6643a73](https://github.com/k2b-dev/cloud/commit/6643a73dbc14a864d1658a6ea6871254814529d1))
* **ui:** stat trends name and format their values in tooltips ([#1420](https://github.com/k2b-dev/cloud/issues/1420)) ([7f42bb3](https://github.com/k2b-dev/cloud/commit/7f42bb35afadaf701bbf3c31617f2431dafae050))


### Bug Fixes

* **spaces:** keep kanban cards and columns in place while a refresh updates them ([#1396](https://github.com/k2b-dev/cloud/issues/1396)) ([0cd224d](https://github.com/k2b-dev/cloud/commit/0cd224d99cd9c952916a83d4a2eafdb0a9ea8085))
* stop WebKit's network process from crashing on Back in browser tests ([#1431](https://github.com/k2b-dev/cloud/issues/1431)) ([#1447](https://github.com/k2b-dev/cloud/issues/1447)) ([4c5d68d](https://github.com/k2b-dev/cloud/commit/4c5d68d9e8a18fb960970e7cbf80815da29c9ff8))

## [0.28.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.27.0...npm-ui-v0.28.0) (2026-10-17)


### Features

* **assistant:** choose the model, search the chat, and run scheduled tasks from the slash menu ([#1305](https://github.com/k2b-dev/cloud/issues/1305)) ([8f63bf4](https://github.com/k2b-dev/cloud/commit/8f63bf4560aa24fb03d034b5b1d6fed1fb0fffea))
* **assistant:** Studio charts print their values as a table ([#1343](https://github.com/k2b-dev/cloud/issues/1343)) ([6c72058](https://github.com/k2b-dev/cloud/commit/6c7205814c51a932a1c0f5a1ac09318986699729))
* **assistant:** Studio charts show tooltips by default ([#1329](https://github.com/k2b-dev/cloud/issues/1329)) ([6cbfff0](https://github.com/k2b-dev/cloud/commit/6cbfff0ba065b9d21dfc941c6c8417b9927eaffb))
* **cloud:** write Help with task kinds, needs, next steps, key caps and details ([#1324](https://github.com/k2b-dev/cloud/issues/1324)) ([48560d3](https://github.com/k2b-dev/cloud/commit/48560d3c861dd4f0d61c03899a583b2928a4379f))
* **notebooks:** a calm note side panel with one action row, clear sections and translated activity ([#1339](https://github.com/k2b-dev/cloud/issues/1339)) ([c1682b4](https://github.com/k2b-dev/cloud/commit/c1682b4bbc0b3e7dd9fe4791697e992f3ec2cc71))
* **notebooks:** read chart values by pointer, tap and keyboard, as a table, or copy them ([#1344](https://github.com/k2b-dev/cloud/issues/1344)) ([3d423e7](https://github.com/k2b-dev/cloud/commit/3d423e7c2114d0674079125943e71288eb26f573))
* **ui:** a floating bottom toolbar that keeps its most important actions and shows key hints ([#1318](https://github.com/k2b-dev/cloud/issues/1318)) ([efdc555](https://github.com/k2b-dev/cloud/commit/efdc5557d69160830306ab0199d2b4ff98cca31f))
* **ui:** draw an avatar's status ring inside the avatar so panels never cut it off ([#1320](https://github.com/k2b-dev/cloud/issues/1320)) ([0d675c0](https://github.com/k2b-dev/cloud/commit/0d675c066d7df8dbcee592a2448deef7bcf26aa5))
* **ui:** know whether a person uses touch, a trackpad or a keyboard without moving anything ([#1291](https://github.com/k2b-dev/cloud/issues/1291)) ([558cb3f](https://github.com/k2b-dev/cloud/commit/558cb3fefaceb22d70c3316aece6658e31b51252))
* **ui:** offer chart inspection without Solid for sandboxed hosts ([#1316](https://github.com/k2b-dev/cloud/issues/1316)) ([6c7d65d](https://github.com/k2b-dev/cloud/commit/6c7d65d4197a16663f67d04a198ce4b18be3e9aa))
* **ui:** open the hold menu at the finger on tablets ([#1335](https://github.com/k2b-dev/cloud/issues/1335)) ([7278cf7](https://github.com/k2b-dev/cloud/commit/7278cf76c497cc303fbd4fcf159153419206a0a6))
* **ui:** print page content without the app chrome, starting with Notebooks ([#1321](https://github.com/k2b-dev/cloud/issues/1321)) ([e1b2b21](https://github.com/k2b-dev/cloud/commit/e1b2b2188d08c9426af13261969a6db12ed03485)), closes [#1281](https://github.com/k2b-dev/cloud/issues/1281)
* **ui:** share the message reaction chips as ReactionBar, with names on hover, focus and a long press ([#1337](https://github.com/k2b-dev/cloud/issues/1337)) ([14e5055](https://github.com/k2b-dev/cloud/commit/14e50552a25d1300f38e801fbe3253e0fd61ec50))
* **ui:** show the slash menu as a sheet above the phone keyboard ([#1336](https://github.com/k2b-dev/cloud/issues/1336)) ([3b4dff1](https://github.com/k2b-dev/cloud/commit/3b4dff10ef1db29409d54a38091510cb5c6dd46e))


### Bug Fixes

* **tools:** convert iPhone HEIC photos and show one calm drop state ([#1284](https://github.com/k2b-dev/cloud/issues/1284)) ([#1330](https://github.com/k2b-dev/cloud/issues/1330)) ([da468f4](https://github.com/k2b-dev/cloud/commit/da468f4d99650caef34578e0802f475017d706ea))

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

## [0.26.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.25.0...npm-ui-v0.26.0) (2026-10-16)


### Features

* **ui:** one motion vocabulary and one reduced-motion switch for every animation ([#1208](https://github.com/k2b-dev/cloud/issues/1208)) ([b24836b](https://github.com/k2b-dev/cloud/commit/b24836b49ce9d936fae3c8ef9262e734125df2f7))


### Bug Fixes

* **spaces:** keep the space settings open when a person is added ([#1222](https://github.com/k2b-dev/cloud/issues/1222)) ([3de096b](https://github.com/k2b-dev/cloud/commit/3de096badaa71c54d0f7ca5ef3acf6668f2c003c))
* **ui:** keep the app sidebar list in place after a reload ([#1197](https://github.com/k2b-dev/cloud/issues/1197)) ([1486c00](https://github.com/k2b-dev/cloud/commit/1486c002c832f7095058890f473452fa73d478dc))

## [0.25.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.24.0...npm-ui-v0.25.0) (2026-10-15)


### Features

* **chat:** keep read positions and unread counts ([#1083](https://github.com/k2b-dev/cloud/issues/1083)) ([9df2652](https://github.com/k2b-dev/cloud/commit/9df2652d330911c7cfb118d3805631c93c602b71))
* **cloud:** switch appearance with one button that cycles Automatic, Light, Dark ([#1131](https://github.com/k2b-dev/cloud/issues/1131)) ([aefeb09](https://github.com/k2b-dev/cloud/commit/aefeb0955897b6f5b85515aa51e5e538e260bd87))
* **filesv2:** create nested and several folders at once with a live path preview ([#1114](https://github.com/k2b-dev/cloud/issues/1114)) ([4c711eb](https://github.com/k2b-dev/cloud/commit/4c711ebc527daca4bc1f77e6c81cd75f5a7d99ef))
* **filesv2:** start Files at an overview of all storage places ([#1129](https://github.com/k2b-dev/cloud/issues/1129)) ([6820878](https://github.com/k2b-dev/cloud/commit/6820878c14a435ac8c7a283e2359964dacc08b91)), closes [#1096](https://github.com/k2b-dev/cloud/issues/1096)
* **notebooks:** a clear toolbar with active states, one shortcut dialect, and finer undo steps ([#1087](https://github.com/k2b-dev/cloud/issues/1087)) ([96e05ce](https://github.com/k2b-dev/cloud/commit/96e05ceda9e47cce42b977f274324b411ac446d0))
* **spaces:** scroll the month view continuously through weeks ([#1108](https://github.com/k2b-dev/cloud/issues/1108)) ([88e5aee](https://github.com/k2b-dev/cloud/commit/88e5aeec2e59be4ecdf4af3b740aa615e9feea22)), closes [#813](https://github.com/k2b-dev/cloud/issues/813)
* **ssr:** mount island props without eval so pages run under a CSP without unsafe-eval ([#1106](https://github.com/k2b-dev/cloud/issues/1106)) ([06b0b42](https://github.com/k2b-dev/cloud/commit/06b0b4280a1dfa858ee4ee4be5b6922106659d72)), closes [#1080](https://github.com/k2b-dev/cloud/issues/1080)
* **ui:** add key caps, label chips, a table of contents, and callout icons ([#1134](https://github.com/k2b-dev/cloud/issues/1134)) ([ae8c68c](https://github.com/k2b-dev/cloud/commit/ae8c68c546bc188add1df26f15c4b1e553a8f777))


### Bug Fixes

* **ui:** calm sidebar hover and wrap long row names instead of scrolling them ([#1093](https://github.com/k2b-dev/cloud/issues/1093)) ([f8a0a44](https://github.com/k2b-dev/cloud/commit/f8a0a4426ff19c7e18c05805fdb88f33ae539274))
* **ui:** keep hover and focus from moving or lifting elements ([#1162](https://github.com/k2b-dev/cloud/issues/1162)) ([2778d49](https://github.com/k2b-dev/cloud/commit/2778d4931a85d408a549b53479ffd073254c0f42))
* **ui:** keep server-rendered month rows in place in WebKit after mount ([#1157](https://github.com/k2b-dev/cloud/issues/1157)) ([1b1561e](https://github.com/k2b-dev/cloud/commit/1b1561e9b5406c74c036b270f75f9fefae2cdf17)), closes [#1132](https://github.com/k2b-dev/cloud/issues/1132)
* **ui:** keep the rounded app card on wide screens for flat workspaces too ([#1135](https://github.com/k2b-dev/cloud/issues/1135)) ([480faf5](https://github.com/k2b-dev/cloud/commit/480faf515983a00cd44e84c8a03f336881756124)), closes [#1088](https://github.com/k2b-dev/cloud/issues/1088)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @k2b/ssr bumped from 0.15.1 to 0.16.0
  * peerDependencies
    * @k2b/ssr bumped from ^0.12.0 || ^0.13.0 || ^0.14.0 || ^0.15.0 || ^0.16.0 to ^0.16.0

## [0.24.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.23.0...npm-ui-v0.24.0) (2026-10-13)


### Features

* **ui:** let the app area reach the window edge in the installed iPad app ([#1067](https://github.com/k2b-dev/cloud/issues/1067)) ([5d6493e](https://github.com/k2b-dev/cloud/commit/5d6493eb92a39fed8e6349e0587c0ce073bc7d71)), closes [#1049](https://github.com/k2b-dev/cloud/issues/1049)
* **ui:** one sidebar switcher for the current notebook, space, mailbox or base in every app ([#1059](https://github.com/k2b-dev/cloud/issues/1059)) ([9783993](https://github.com/k2b-dev/cloud/commit/9783993ffd04b327fc242c38a009a49a874a05e1)), closes [#1047](https://github.com/k2b-dev/cloud/issues/1047)


### Bug Fixes

* **ui:** keep the selected event beside the detail in the day and week views with dayHours ([#1076](https://github.com/k2b-dev/cloud/issues/1076)) ([5095e7f](https://github.com/k2b-dev/cloud/commit/5095e7fb4abce838fe6d0f7fbd11d9f201f52c3b)), closes [#1066](https://github.com/k2b-dev/cloud/issues/1066)
* **ui:** keep wide boards and tables tidy beside the detail panel ([#1015](https://github.com/k2b-dev/cloud/issues/1015)) ([2dd2777](https://github.com/k2b-dev/cloud/commit/2dd2777438e12cb59ae1fd7a9a1fa2adf4f8ac52)), closes [#1031](https://github.com/k2b-dev/cloud/issues/1031)
* **ui:** leave the focus where the person went when a slow quick create save closes ([#1072](https://github.com/k2b-dev/cloud/issues/1072)) ([b674abf](https://github.com/k2b-dev/cloud/commit/b674abf8a32700d9e35a07703e4df0d35188e08f)), closes [#1063](https://github.com/k2b-dev/cloud/issues/1063)
* **ui:** let the week's hours glide to a selected day and keep items clear of the hour gutter ([#1061](https://github.com/k2b-dev/cloud/issues/1061)) ([2361b12](https://github.com/k2b-dev/cloud/commit/2361b12049baf19cd18941230c36d18517ca859d))
* **ui:** sidebar switcher keeps app colors on phones, never covers or jumps around its trigger, and keeps one head height ([#1075](https://github.com/k2b-dev/cloud/issues/1075)) ([6eaef4b](https://github.com/k2b-dev/cloud/commit/6eaef4b7d46d1f94a38934eecd7b69011c7b2ad0))


### Performance Improvements

* **cloud:** render the app shell with at most four islands ([#1033](https://github.com/k2b-dev/cloud/issues/1033)) ([759266b](https://github.com/k2b-dev/cloud/commit/759266bc70bf702871832013dc3cfdaf98afff94))
* **cloud:** stop loading dayjs and big.js on pages that do not use them ([#1065](https://github.com/k2b-dev/cloud/issues/1065)) ([84fcc0b](https://github.com/k2b-dev/cloud/commit/84fcc0bb258aeb22f0e9152800c8c7411d82e65e))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @k2b/ssr bumped from 0.15.0 to 0.15.1
  * peerDependencies
    * @k2b/ssr bumped from ^0.12.0 || ^0.13.0 || ^0.14.0 || ^0.15.0 to ^0.15.1

## [0.23.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.22.0...npm-ui-v0.23.0) (2026-10-12)


### Features

* **ai:** chart groups with a shared cursor, more chart kinds and one render path ([#965](https://github.com/k2b-dev/cloud/issues/965)) ([98fd68a](https://github.com/k2b-dev/cloud/commit/98fd68af0d2a6c09a7bff6c6b858f27c493091a3))
* **ai:** explore a computed dataset in the chat with views, filters and comparison ([#986](https://github.com/k2b-dev/cloud/issues/986)) ([cf55b85](https://github.com/k2b-dev/cloud/commit/cf55b850f6a15d1c1f71cecf247dfac83aa54c3d))
* **ai:** show charts and tables computed in code runs without retyping their values ([#949](https://github.com/k2b-dev/cloud/issues/949)) ([49399e0](https://github.com/k2b-dev/cloud/commit/49399e0a7f3d9f4e0880697e60794bfa1f30e52f))
* **ai:** show key figures, record details and linked Cloud objects from code runs ([#972](https://github.com/k2b-dev/cloud/issues/972)) ([0898cc3](https://github.com/k2b-dev/cloud/commit/0898cc380ba2f7b77eee23286113a18bac56fbaa))
* **cloud:** approve pending actions inside Cloud, in the owning app and in the Assistant ([#963](https://github.com/k2b-dev/cloud/issues/963)) ([cf15171](https://github.com/k2b-dev/cloud/commit/cf151710d46bceb04f21059f46179f63f1831c6f))
* **notebooks:** list numbers repair themselves, indent without Tab, and move items with their sub-items ([#1010](https://github.com/k2b-dev/cloud/issues/1010)) ([6e7b973](https://github.com/k2b-dev/cloud/commit/6e7b9737dc7d0b599c53732e67385e6a8f9139e0))
* **spaces:** day and week views with a 06:00 day start, folded nights and scrolling between days ([#1025](https://github.com/k2b-dev/cloud/issues/1025)) ([d8d1bdf](https://github.com/k2b-dev/cloud/commit/d8d1bdf8a9d3ae55601914f2b5601eef32bdeb7b))
* **spaces:** step through items with J and K while the detail panel is open ([#1040](https://github.com/k2b-dev/cloud/issues/1040)) ([d1d84b4](https://github.com/k2b-dev/cloud/commit/d1d84b40a9de586d02a01dac812f65b6c3353656))
* **ui:** give the detail panel the full height and drop page titles the sidebar already shows ([#1003](https://github.com/k2b-dev/cloud/issues/1003)) ([081daf9](https://github.com/k2b-dev/cloud/commit/081daf9c4497590c181648ac5d3f13de7cde5038))
* **ui:** show row actions only on the hovered row when a tablet has a mouse ([#989](https://github.com/k2b-dev/cloud/issues/989)) ([32bb9d0](https://github.com/k2b-dev/cloud/commit/32bb9d0dd118e86c9d6716280c7f82f0829d7124))


### Bug Fixes

* **ui:** give sidebar rows the same inset on the right as on the left ([#974](https://github.com/k2b-dev/cloud/issues/974)) ([514b9f9](https://github.com/k2b-dev/cloud/commit/514b9f9a8dff7b3f656e18becaaef77cbd54a067))
* **ui:** keep the conversation composer's placeholder on one line on phones ([#995](https://github.com/k2b-dev/cloud/issues/995)) ([3cbd442](https://github.com/k2b-dev/cloud/commit/3cbd4429aaa6bcad3e7e653157d323b3a05af34c))
* **ui:** keep the selected week or day calendar event beside the tablet detail drawer ([#1032](https://github.com/k2b-dev/cloud/issues/1032)) ([f220f1e](https://github.com/k2b-dev/cloud/commit/f220f1ec0679d9906dc6f9feb5613b33c4bd21d3)), closes [#945](https://github.com/k2b-dev/cloud/issues/945)
* **ui:** let one Escape close a dialog whose first field is a Combobox ([#970](https://github.com/k2b-dev/cloud/issues/970)) ([c68cb37](https://github.com/k2b-dev/cloud/commit/c68cb375599197df0722c0bbeebe4e313f5d2628))

## [0.22.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.21.0...npm-ui-v0.22.0) (2026-10-11)


### Features

* **cloud:** use the whole window on tablets and laptops, and show the way up to the pages above ([#908](https://github.com/k2b-dev/cloud/issues/908)) ([677cf5d](https://github.com/k2b-dev/cloud/commit/677cf5dbde0dd7f66f2f91a7826f3aad9ae6ea52))
* **dashboard:** one board of widgets in three sizes that people can arrange themselves ([#885](https://github.com/k2b-dev/cloud/issues/885)) ([0ff5872](https://github.com/k2b-dev/cloud/commit/0ff5872d5f558b41b27dfa43b50e7d3da6f4b67e))
* **notebooks:** one sidebar instead of the Navigator and simple modes ([#916](https://github.com/k2b-dev/cloud/issues/916)) ([42df3f6](https://github.com/k2b-dev/cloud/commit/42df3f610df8daad48a0edaaec9984a6e7aa7cc0))
* **spaces:** give ticking a task off hover feedback, a short animation, and Undo ([#906](https://github.com/k2b-dev/cloud/issues/906)) ([6e85414](https://github.com/k2b-dev/cloud/commit/6e85414594e375bdac11f2b9569edfacb343e279))
* **ui:** float the workspace detail panel instead of docking it ([#934](https://github.com/k2b-dev/cloud/issues/934)) ([cf25e0b](https://github.com/k2b-dev/cloud/commit/cf25e0b06f009dda6a8c51321bdfd7ce31e9147f))
* **ui:** keep drags from selecting page text on iPad ([#902](https://github.com/k2b-dev/cloud/issues/902)) ([d65a827](https://github.com/k2b-dev/cloud/commit/d65a827d24a8a7fa10589d07be52e8dc561a1ea4))


### Bug Fixes

* **ai:** align the expanded work flush left and fold repeated steps into one row ([#928](https://github.com/k2b-dev/cloud/issues/928)) ([ffa193b](https://github.com/k2b-dev/cloud/commit/ffa193be5202be3ae74908df3aa3897f701f929a))
* **ui:** open hover previews only for the row still under the mouse ([#883](https://github.com/k2b-dev/cloud/issues/883)) ([d9718f7](https://github.com/k2b-dev/cloud/commit/d9718f7695d46b7aff46e33584f6533f619f5e9f))


### Performance Improvements

* **ui:** split the message catalog per component family so small imports stay small ([#936](https://github.com/k2b-dev/cloud/issues/936)) ([b8373dc](https://github.com/k2b-dev/cloud/commit/b8373dc432eea88a183ad652b3e09d90c722ba74)), closes [#841](https://github.com/k2b-dev/cloud/issues/841)

## [0.21.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.20.0...npm-ui-v0.21.0) (2026-10-10)


### Features

* **dashboard:** stream widgets in as they load instead of failing the whole board ([#831](https://github.com/k2b-dev/cloud/issues/831)) ([e7ff2ce](https://github.com/k2b-dev/cloud/commit/e7ff2ce2c13a4a6e2e49fc4c2ef7b9a236ca78b9))
* **spaces:** select days, create over a range, and show long events as one bar in the month view ([#826](https://github.com/k2b-dev/cloud/issues/826)) ([ed10713](https://github.com/k2b-dev/cloud/commit/ed1071320af6a09e177d4115f15328bcfb7bc8a7))
* **ui:** mark today in every date picker ([#839](https://github.com/k2b-dev/cloud/issues/839)) ([de47b30](https://github.com/k2b-dev/cloud/commit/de47b3010ac5a6f0ef32aff638edaa30dadf50d2))


### Bug Fixes

* **ui:** keep busy buttons at their width and name them by their loading label ([#845](https://github.com/k2b-dev/cloud/issues/845)) ([1bd875a](https://github.com/k2b-dev/cloud/commit/1bd875ae479b276cdcea6e3d11a1f95cc1257325))
* **ui:** show bare dialogs on iPad instead of only blurring the page ([#799](https://github.com/k2b-dev/cloud/issues/799)) ([285b00f](https://github.com/k2b-dev/cloud/commit/285b00ff6b655443e468bf6e167a82ad5ffd2fec))

## [0.20.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.19.0...npm-ui-v0.20.0) (2026-10-09)


### Features

* **ui:** add swipe, long-press and double-tap gestures ([#786](https://github.com/k2b-dev/cloud/issues/786)) ([6f72eae](https://github.com/k2b-dev/cloud/commit/6f72eae8d64a6d9f5a728a93e6cee31e83a04579))


### Bug Fixes

* **scripts:** run one heavy check or test run per machine with bounded type checkers ([#791](https://github.com/k2b-dev/cloud/issues/791)) ([bbc4932](https://github.com/k2b-dev/cloud/commit/bbc493290e9088dbbf2c3f14b4ea141a6609eca5))
* **ui:** keep phone keyboards from capitalizing user names and addresses ([#792](https://github.com/k2b-dev/cloud/issues/792)) ([5b9b9a1](https://github.com/k2b-dev/cloud/commit/5b9b9a14d91593014a8f1f71e50d4e5e650b2a6b))
* **ui:** keep short table columns readable next to long ones ([#785](https://github.com/k2b-dev/cloud/issues/785)) ([4f12a78](https://github.com/k2b-dev/cloud/commit/4f12a7807795dc66e68e38d834bb7be4e8ed2967))
* **ui:** keep the chat composer's formatting row short and aligned with the field ([#789](https://github.com/k2b-dev/cloud/issues/789)) ([ae018fc](https://github.com/k2b-dev/cloud/commit/ae018fc7a8a27389aaad7bd33aeb89f78d2ed607))

## [0.19.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.18.0...npm-ui-v0.19.0) (2026-10-09)


### Features

* **ai:** show the Studio check calmly in the chat ([#766](https://github.com/k2b-dev/cloud/issues/766)) ([f3c6342](https://github.com/k2b-dev/cloud/commit/f3c63426d16e2ffe512f4b08b4ac9463ca53e03f))
* attach files from Cloud apps in Spaces, Grids, Notebooks and Assistant ([#749](https://github.com/k2b-dev/cloud/issues/749)) ([435d7ae](https://github.com/k2b-dev/cloud/commit/435d7aedea05cf4ab42d7911e2b2fc57c2f84815))
* **cloud:** show a calm error state instead of a frozen app view ([#740](https://github.com/k2b-dev/cloud/issues/740)) ([1fd7220](https://github.com/k2b-dev/cloud/commit/1fd7220f21382424ded073a5e843a02949a25930))
* save attachments into Files from Mail and other apps ([#765](https://github.com/k2b-dev/cloud/issues/765)) ([a6d9ae9](https://github.com/k2b-dev/cloud/commit/a6d9ae939a94886750904160ab904524b1e79d45))
* **spaces:** add a timeline calendar view ([#763](https://github.com/k2b-dev/cloud/issues/763)) ([fae29fa](https://github.com/k2b-dev/cloud/commit/fae29fa06de80b69059ab04f794ff7eedde59a76))
* **spaces:** add task and event templates ([#764](https://github.com/k2b-dev/cloud/issues/764)) ([8c98ecd](https://github.com/k2b-dev/cloud/commit/8c98ecd44e17bf517554caad1c74eb9051d2b076))
* **spaces:** color calendar items by their tags and choose what the color shows ([#754](https://github.com/k2b-dev/cloud/issues/754)) ([c396691](https://github.com/k2b-dev/cloud/commit/c3966915d0fdaaef59182a7d75d99f8035dcf5aa))
* **ui:** add a resource card that keeps its height in every state ([#746](https://github.com/k2b-dev/cloud/issues/746)) ([01c1a95](https://github.com/k2b-dev/cloud/commit/01c1a95d60fff513fa574bec9f1384584ce0c974))
* **ui:** add a SignatureInput that draws with finger, pen or mouse or types the name ([#782](https://github.com/k2b-dev/cloud/issues/782)) ([b85ebd8](https://github.com/k2b-dev/cloud/commit/b85ebd8bef26699613b8e3c56d209944b17f7efc)), closes [#708](https://github.com/k2b-dev/cloud/issues/708)
* **ui:** add a Timeline that shows time as a continuous filmstrip ([#751](https://github.com/k2b-dev/cloud/issues/751)) ([fe0980d](https://github.com/k2b-dev/cloud/commit/fe0980d684e6b0a7596737aa8abd18e9cd3658da))
* **ui:** add an emoji picker with search, recents and skin tones ([#778](https://github.com/k2b-dev/cloud/issues/778)) ([1e291a9](https://github.com/k2b-dev/cloud/commit/1e291a9b5e3f4dc69b25a50bdef30ddef97f89c0))
* **ui:** grow the chat composer from one line with formatting on demand ([#770](https://github.com/k2b-dev/cloud/issues/770)) ([d5e7ff2](https://github.com/k2b-dev/cloud/commit/d5e7ff2c5f4b222ec20a59ac3756728f165274ba))
* **ui:** show counts, dots and mention marks in sidebar items ([#756](https://github.com/k2b-dev/cloud/issues/756)) ([16122af](https://github.com/k2b-dev/cloud/commit/16122afd3883741c79911ef6753758160443742d))


### Bug Fixes

* **ui:** keep PdfPreview loading until the PDF has loaded and explain a missing viewer ([#767](https://github.com/k2b-dev/cloud/issues/767)) ([938dbb1](https://github.com/k2b-dev/cloud/commit/938dbb14c1979e6349feeb3c0fe1f67f56979fd8))
* **ui:** make a renewed VideoPlayer address continue where it stopped in WebKit ([#768](https://github.com/k2b-dev/cloud/issues/768)) ([be7b95c](https://github.com/k2b-dev/cloud/commit/be7b95ce52dd64600700207af4f37d706e5b2a37))

## [0.18.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.17.0...npm-ui-v0.18.0) (2026-10-08)


### Features

* **ai:** calm, clear Assistant surfaces ([#719](https://github.com/k2b-dev/cloud/issues/719)) ([400da10](https://github.com/k2b-dev/cloud/commit/400da1004a259e12135050f249f565d45fe4de9b))
* **ai:** keep failed turns visible with a clear next step ([#712](https://github.com/k2b-dev/cloud/issues/712)) ([2edd0da](https://github.com/k2b-dev/cloud/commit/2edd0da4d48a98ade02a23a4604f4c81a1abdce6))
* **filesv2:** play videos in Files and attach them in Spaces ([#714](https://github.com/k2b-dev/cloud/issues/714)) ([6cd619d](https://github.com/k2b-dev/cloud/commit/6cd619dd4fa1a17a1b3d6e8ad7d12024f38cb610))
* **notebooks:** let writers order notes by hand ([#731](https://github.com/k2b-dev/cloud/issues/731)) ([0835dee](https://github.com/k2b-dev/cloud/commit/0835dee1ebedd72323089d1156abf62b98245f5e))
* **notebooks:** list the homepage note in the tree with a home icon ([#726](https://github.com/k2b-dev/cloud/issues/726)) ([304d103](https://github.com/k2b-dev/cloud/commit/304d1031d681735c88286bc8e95f0623397ec86a))
* **ui:** calm reference pills and quiet links in every Markdown view ([#733](https://github.com/k2b-dev/cloud/issues/733)) ([4b00e92](https://github.com/k2b-dev/cloud/commit/4b00e92e52a9a54e28b4020732e96fe830d46be9))
* **ui:** drop files anywhere on the page, not into a thin strip ([#718](https://github.com/k2b-dev/cloud/issues/718)) ([732e64a](https://github.com/k2b-dev/cloud/commit/732e64a49cacf2fcd2608200a18da6815cba2a75))


### Bug Fixes

* **ui:** give table lines and hover highlights one consistent width ([#722](https://github.com/k2b-dev/cloud/issues/722)) ([e9bd63e](https://github.com/k2b-dev/cloud/commit/e9bd63e84a6208cdca8e2f0b947a720823da142e))
* **ui:** make the VideoPlayer playback tests reach the end reliably in WebKit ([#724](https://github.com/k2b-dev/cloud/issues/724)) ([be41bb8](https://github.com/k2b-dev/cloud/commit/be41bb81d87af0e29e9199cbd0f942897ee35021))

## [0.17.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.16.0...npm-ui-v0.17.0) (2026-10-07)


### Features

* **mail:** show mailbox details to everyone who can read it ([#703](https://github.com/k2b-dev/cloud/issues/703)) ([2b5b306](https://github.com/k2b-dev/cloud/commit/2b5b306c1eb913cdeec589bf8eaab665220ce110))

## [0.16.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.15.0...npm-ui-v0.16.0) (2026-10-07)


### ⚠ BREAKING CHANGES

* **ai:** fold finished work into one summary line ([#692](https://github.com/k2b-dev/cloud/issues/692))

### Features

* **ai:** fold finished work into one summary line ([#692](https://github.com/k2b-dev/cloud/issues/692)) ([b4cd708](https://github.com/k2b-dev/cloud/commit/b4cd708d85581db60c51ebd7a863ea77c32cefca))
* **ui:** add a classless base stylesheet for HTML apps ([#695](https://github.com/k2b-dev/cloud/issues/695)) ([8a83654](https://github.com/k2b-dev/cloud/commit/8a83654754e200e85f624ffb104a756b21b36bcd))


### Bug Fixes

* **ai:** show capabilities and approvals in the reader's language ([#682](https://github.com/k2b-dev/cloud/issues/682)) ([2c70089](https://github.com/k2b-dev/cloud/commit/2c700894d34f4b0ef5608931433f41a749dc9a10))

## [0.15.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.14.0...npm-ui-v0.15.0) (2026-10-06)


### Features

* **browser:** attach files from Cloud apps through one source chooser ([#672](https://github.com/k2b-dev/cloud/issues/672)) ([be21047](https://github.com/k2b-dev/cloud/commit/be21047cabbe011445242a62636fac25fcb3b33f))
* **ui:** add a virtualized message list that keeps the reading position ([#668](https://github.com/k2b-dev/cloud/issues/668)) ([67b39a4](https://github.com/k2b-dev/cloud/commit/67b39a4b85f8f218984b71ba328e1da8ca499666))
* **ui:** add message rows for conversations with many people ([#676](https://github.com/k2b-dev/cloud/issues/676)) ([0598121](https://github.com/k2b-dev/cloud/commit/059812142bfb38e60ac10aa981cf69a0b949304b))
* **ui:** keep the QR camera running and say why it cannot start ([#675](https://github.com/k2b-dev/cloud/issues/675)) ([8861ae7](https://github.com/k2b-dev/cloud/commit/8861ae7a562b70898b05fead34f530630fbd78b2))
* **ui:** send Samsung Internet to Chrome to install apps on Android ([#674](https://github.com/k2b-dev/cloud/issues/674)) ([c23e072](https://github.com/k2b-dev/cloud/commit/c23e07260d64160845c01b5d5a7f79586d083dc2))
* **ui:** show quotes, reactions, threads and rich content in message rows ([#680](https://github.com/k2b-dev/cloud/issues/680)) ([626a12c](https://github.com/k2b-dev/cloud/commit/626a12c6ff9abce21707fa305a6735e752678ccf))


### Bug Fixes

* **ui:** keep VirtualFeed's place through flings, resizes and keyboard scrolling ([#678](https://github.com/k2b-dev/cloud/issues/678)) ([147a2e0](https://github.com/k2b-dev/cloud/commit/147a2e011c95e859fe883de5cf6bf53449e612cf))

## [0.14.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.13.0...npm-ui-v0.14.0) (2026-10-06)


### Features

* **pwa:** switch app tabs at the first touch ([#640](https://github.com/k2b-dev/cloud/issues/640)) ([74cad11](https://github.com/k2b-dev/cloud/commit/74cad11ad1accdc9267c90e5fdc7c7695547f802))
* **ui:** render info blocks in every Markdown view ([#655](https://github.com/k2b-dev/cloud/issues/655)) ([d1382ed](https://github.com/k2b-dev/cloud/commit/d1382ed0d25ad8ef149e484dbcb401429b6f09fd))


### Bug Fixes

* **ui:** keep focus that moved before a dialog's first frame ([#665](https://github.com/k2b-dev/cloud/issues/665)) ([2573f5c](https://github.com/k2b-dev/cloud/commit/2573f5cec1019a2e146c458f4dfc85a64b96443a))

## [0.13.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.12.0...npm-ui-v0.13.0) (2026-10-05)


### Features

* **core:** flatten the account pages ([#572](https://github.com/k2b-dev/cloud/issues/572)) ([deaf537](https://github.com/k2b-dev/cloud/commit/deaf537c25414d89785ef24407b839d880c49252))
* **notebooks:** preview attached files instead of only downloading them ([#574](https://github.com/k2b-dev/cloud/issues/574)) ([8c443eb](https://github.com/k2b-dev/cloud/commit/8c443eb73cde98ff26c98035d0ab15d7fc9f80c1))
* **pwa:** add the installable mobile app ([#605](https://github.com/k2b-dev/cloud/issues/605)) ([27e42cc](https://github.com/k2b-dev/cloud/commit/27e42cc1eccaf4b1943645fcb7cf34855507bc22))
* **pwa:** calm app shell without lines and warn when the install page is not open in Safari ([#626](https://github.com/k2b-dev/cloud/issues/626)) ([4a64cc8](https://github.com/k2b-dev/cloud/commit/4a64cc874e7e10e180b5b90d0ccf58fc24af6abd))
* **ui:** announce action outcomes to screen readers in every app ([#616](https://github.com/k2b-dev/cloud/issues/616)) ([e19e7ac](https://github.com/k2b-dev/cloud/commit/e19e7ac8b67ab7bfb0c5433a97cce68197f01485))
* **ui:** share phone app building blocks with Cloud Login ([#591](https://github.com/k2b-dev/cloud/issues/591)) ([394af22](https://github.com/k2b-dev/cloud/commit/394af22d4053b7418481ee25beda9288b88d038b))


### Bug Fixes

* announce quiet confirmations in Spaces, confirm hidden completions with Undo, and keep create and edit dialogs open until saved ([#585](https://github.com/k2b-dev/cloud/issues/585)) ([0a40a67](https://github.com/k2b-dev/cloud/commit/0a40a675282a976597c0a6f5d406cecb3e5d45aa))
* give every detail panel section the same flat frame, comments included ([#592](https://github.com/k2b-dev/cloud/issues/592)) ([42e81a6](https://github.com/k2b-dev/cloud/commit/42e81a6a6d9ff36d01fda71b73ac23b5a423795c))
* **pwa:** open app pages on the first tap and check off tasks instantly ([#622](https://github.com/k2b-dev/cloud/issues/622)) ([0c063eb](https://github.com/k2b-dev/cloud/commit/0c063ebcd856cfd4991a2830d0fc940bd4cdf9ec))
* **ui:** finish the flat-frame sweep in dialogs and keep Mail's detail layout ([#595](https://github.com/k2b-dev/cloud/issues/595)) ([ff405ea](https://github.com/k2b-dev/cloud/commit/ff405eacda76c76b3e81182568b0f6494f6a2a02))
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
