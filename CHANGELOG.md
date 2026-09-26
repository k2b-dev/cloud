# Changelog

release-please maintains this file from the next release on. Do not edit it by
hand; entries come from squash-commit titles on `main`.

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
