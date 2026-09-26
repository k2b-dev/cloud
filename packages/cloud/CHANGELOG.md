# Changelog

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
