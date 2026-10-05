# Changelog

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
