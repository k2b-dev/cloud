:robot: I have created a release *beep* *boop*
---


<details><summary>npm-cloud: 0.79.0</summary>

## [0.79.0](https://github.com/k2b-dev/cloud/compare/npm-cloud-v0.78.0...npm-cloud-v0.79.0) (2026-11-28)


###   BREAKING CHANGES

* **faq:** Before upgrading, export entries with the old running application using cld --profile ADMIN_PROFILE faq list --json > faq-export.json. Core permanently drops the faq schema and its entries. A restarted old FAQ container recreates an empty schema, so remove its automatic restart/deployment configuration first. After upgrade, recovery requires a pre-upgrade export/backup. Copy content into Notebook notes if needed; review sharing/languages. Help does not import entries automatically. Remove the cached faq CLI plugin after exporting and update old URLs/integrations. Stop/remove app-faq with the previous deployment configuration, remove its workload/service/key mount, and wait at least three minutes before upgrading Core. Core deletes remembered registry/package records, app keys and service accounts with their grants, application access, settings/domains, rail and chooser/consent preferences, notifications and deliveries, approvals and remembered approval grants, Help/search documents and Skill catalogs, app-owned Code, workflow runs/scopes and AI admission/budget state, event subscriptions/outbox data, and the app's own provider execution/idempotency records. Explicit retired-app grants in non-revoked mandates are pruned and affected active mandates are paused and audited. Historical audit events, AI inference/quota and structured-run records, outgoing-mail messages, logging and other providers' capability executions remain, including executions called through the removed app. An app.removed audit is written only when rows are removed or changed, with separate deletion/change counts; fresh installations get no event. Revoked mandates owned by other apps stay unchanged. Dependent cascades are additional. Other apps' data stays. Cleanup can extend Core startup on large installations; wait for Core readiness.
* **capabilities:** The inspector had no owned schema or authored content, so there is no application export command. Back up the database first if removed operational records are needed. The platform capabilities schema/API/CLI and provider applications stay; update old inspector links and catalog-search integrations. Stop/remove app-capabilities with the previous deployment configuration, remove its workload/service/key mount, and wait at least three minutes before upgrading Core. Core deletes remembered registry/package records, app keys and service accounts with their grants, application access, settings/domains, rail and chooser/consent preferences, notifications and deliveries, approvals and remembered approval grants, Help/search documents and Skill catalogs, app-owned Code, workflow runs/scopes and AI admission/budget state, event subscriptions/outbox data, and the app's own provider execution/idempotency records. Explicit retired-app grants in non-revoked mandates are pruned and affected active mandates are paused and audited. Historical audit events, AI inference/quota and structured-run records, outgoing-mail messages, logging and other providers' capability executions remain, including executions called through the removed app. An app.removed audit is written only when rows are removed or changed, with separate deletion/change counts; fresh installations get no event. Revoked mandates owned by other apps stay unchanged. Dependent cascades are additional. Other apps' data stays. Cleanup can extend Core startup on large installations; wait for Core readiness.
* **stdlib:** @k2b/stdlib no longer exports `charts`, `scatter`, `line`, `bar`, `pie`, `donut`, `sparkline`, `histogram`, `boxplot`, `gauge`, `barGauge`, `stat`, `heatmap`, `map`, `stateTimeline`, `chartDatumSvg`, `svgRoot`, `escapeXml`, `normalizePadding`, `computeDomain`, `niceStep`, `extendDomainToNice`, `mapRange`, `mapLog`, `niceLogTicks`, `linearRegression`, `computeBoxStats`, `autoBin`, `linePathD`, `smoothPathD`, `arcPathD`, `markerPath`, `stepPathD` or the types `Point`, `Series`, `MarkerShape`, `LineStyle`, `MapPoint`, `MapSeries`, `MapViewport`, `MapOptions`, `BarItem`, `SliceItem`, `AxisOptions`, `Padding`, `ChartDatum`, `ChartOptions`, `ReferenceLine`. Replacement: render with `Chart` from `@k2b/ui/charts`, or import the same names from `@k2b/ui/charts/core`, which keeps their signatures and markup.

### Features

* **accounts:** users and groups filter, sort and group in the URL on v2 ([#4156](https://github.com/k2b-dev/cloud/issues/4156)) ([e07318c](https://github.com/k2b-dev/cloud/commit/e07318c3af4ce02ae863d06008d7ed3d01d10611))
* **capabilities:** the capabilities app is removed ([#4176](https://github.com/k2b-dev/cloud/issues/4176)) ([d350dee](https://github.com/k2b-dev/cloud/commit/d350deeb0f9bc038866e092d17a0bb87c8e9913d))
* **cloud:** a panel page can be built with @k2b/ui/v2 (PanelLayout ui="v2") ([#4311](https://github.com/k2b-dev/cloud/issues/4311)) ([63e2aec](https://github.com/k2b-dev/cloud/commit/63e2aec8e478f2c5a086f1cfdd13f0ed96bcd73c))
* **cloud:** a v2 principal picker, and the v2 permission editor adds with it ([#4415](https://github.com/k2b-dev/cloud/issues/4415)) ([98a7649](https://github.com/k2b-dev/cloud/commit/98a7649b24a742400370f79f40f30c2b1c9314f5))
* **cloud:** admin pages can run on UI v2 with their sidebar ([#4169](https://github.com/k2b-dev/cloud/issues/4169)) ([21d37ed](https://github.com/k2b-dev/cloud/commit/21d37edce1b88af29f0a1f447b9374b85636583c))
* **cloud:** applications count the members of the reader's own groups ([#4304](https://github.com/k2b-dev/cloud/issues/4304)) ([d4a03ab](https://github.com/k2b-dev/cloud/commit/d4a03ab641251463b2aa3588874f8cc94271cc6c))
* **cloud:** islands load one module of @k2b/cloud/shared and no v1 code for their error fallback ([#4242](https://github.com/k2b-dev/cloud/issues/4242)) ([03700a1](https://github.com/k2b-dev/cloud/commit/03700a1b938de5edd6f6d7eeaa8bac7f417f9f38))
* **cloud:** on the phone a v2 page's search sits in the shell's phone bar ([#4162](https://github.com/k2b-dev/cloud/issues/4162)) ([73e08c0](https://github.com/k2b-dev/cloud/commit/73e08c096c54650e7a3a7edea5326f3444233c06))
* **cloud:** the access dialog opens on UI v2 from v2 pages ([#4207](https://github.com/k2b-dev/cloud/issues/4207)) ([f7bcbd2](https://github.com/k2b-dev/cloud/commit/f7bcbd2208afe53eddc576e5a0d1c56ac52d26c9))
* **cloud:** the access summary and dialog show faces and marks on UI v2 ([#4222](https://github.com/k2b-dev/cloud/issues/4222)) ([67a729a](https://github.com/k2b-dev/cloud/commit/67a729a937f9b320fa91dda7eca4430b3491f3e5))
* **cloud:** v2 visitor pages load Core's v2.css alone ([#4231](https://github.com/k2b-dev/cloud/issues/4231)) ([1be3596](https://github.com/k2b-dev/cloud/commit/1be359605e203e56565233e97ca391502aa0f6fd))
* **cloud:** visitor pages render on UI v2 with MinimalLayout ui v2 ([#4227](https://github.com/k2b-dev/cloud/issues/4227)) ([29e506b](https://github.com/k2b-dev/cloud/commit/29e506b27a83177e0f30642485325920e6e4482c))
* **core:** /admin opens the operations overview, or Apps without it, instead of a start page of its own ([#4541](https://github.com/k2b-dev/cloud/issues/4541)) ([7625f20](https://github.com/k2b-dev/cloud/commit/7625f200be51ef66c799d2da103adb0930479ad2))
* **core:** account pages and pairing run on UI v2 with one account and one activity ([#4173](https://github.com/k2b-dev/cloud/issues/4173)) ([2754b0f](https://github.com/k2b-dev/cloud/commit/2754b0fc702f6595639c6db3fedd1ed1fb0ffc0c))
* **core:** AI and Code administration run on UI v2 ([#4396](https://github.com/k2b-dev/cloud/issues/4396)) ([af8b9d9](https://github.com/k2b-dev/cloud/commit/af8b9d948932d89a0e31eda877326b1a688c0882))
* **core:** Core administration runs on UI v2 ([#4174](https://github.com/k2b-dev/cloud/issues/4174)) ([9e1f7b1](https://github.com/k2b-dev/cloud/commit/9e1f7b1d491105630d48873b98a5f8db2710a728))
* **faq:** the FAQ app is removed ([#4178](https://github.com/k2b-dev/cloud/issues/4178)) ([4964b1f](https://github.com/k2b-dev/cloud/commit/4964b1f40b8cd69648e15fe4967d98e3cd45abc9))
* **grids:** workflow run stats carry a bounded time series ([#4347](https://github.com/k2b-dev/cloud/issues/4347)) ([3fc6db2](https://github.com/k2b-dev/cloud/commit/3fc6db25d8a02b9d147c18f3af91fd12b10e9b10))
* **mail:** Mail's list and reader are built on @k2b/ui v2 behind a pilot setting ([#4104](https://github.com/k2b-dev/cloud/issues/4104)) ([d4cddb9](https://github.com/k2b-dev/cloud/commit/d4cddb914fa7452e0cd69737dacc2fdab01057d1))
* **proxy-auth:** Proxy Auth runs on UI v2 ([#4246](https://github.com/k2b-dev/cloud/issues/4246)) ([1048509](https://github.com/k2b-dev/cloud/commit/10485091dc54ab096d845d54f4311df717223ba5))
* **ssr:** island props travel in a comment instead of an escaped attribute ([#4510](https://github.com/k2b-dev/cloud/issues/4510)) ([8b24085](https://github.com/k2b-dev/cloud/commit/8b240854cfb5ab2d21175f753cb23768111dcba0))
* **stdlib:** charts live only in @k2b/ui/charts ([#4143](https://github.com/k2b-dev/cloud/issues/4143)) ([276ef71](https://github.com/k2b-dev/cloud/commit/276ef71df312eaba3f71707914aeb8dd4eb995c8))
* **ui:** a v2 nav holds a search, a main action and an app's own list, which is the phone's page ([#4443](https://github.com/k2b-dev/cloud/issues/4443)) ([d9714e7](https://github.com/k2b-dev/cloud/commit/d9714e7dcd9cddaef0434766f3bb448a95d322b2))
* **ui:** a v2 RangeBar shows a range on a shared scale, and a v2 icon takes a data colour ([#4442](https://github.com/k2b-dev/cloud/issues/4442)) ([f34ea3d](https://github.com/k2b-dev/cloud/commit/f34ea3dcfef792aea291ae35f7bbc644cfd58589))
* **ui:** a v2 sidebar entry shows work that runs in the place of its dot ([#4281](https://github.com/k2b-dev/cloud/issues/4281)) ([e8967cd](https://github.com/k2b-dev/cloud/commit/e8967cd31e00e19dcbfcfe19ef8f399c3763e34d))
* **ui:** people's faces spread over eleven hues that stay readable and apart, also for colour-blind people ([#4530](https://github.com/k2b-dev/cloud/issues/4530)) ([6a644ae](https://github.com/k2b-dev/cloud/commit/6a644ae24f39c75110c11526d7e71cf34cde9532))
* **ui:** v2 navigation and tables show trees ([#4187](https://github.com/k2b-dev/cloud/issues/4187)) ([4fca75e](https://github.com/k2b-dev/cloud/commit/4fca75ebda3681c9170b37b31edbddd00938512c))
* **ui:** v2 rows part with a quiet line, and the open row takes the tint of the app it belongs to ([#4355](https://github.com/k2b-dev/cloud/issues/4355)) ([0190356](https://github.com/k2b-dev/cloud/commit/01903569451c0088cba04fe66356fe20beb3c502))
* **ui:** v2 rows show they are selected and an open detail on the phone has one way back ([#4111](https://github.com/k2b-dev/cloud/issues/4111)) ([bcf947a](https://github.com/k2b-dev/cloud/commit/bcf947a74e8bce5aedc1ac9398699ba1ee6cc300))
* **ui:** v2 tabs open their menu, sidebars fold and carry deeds, and a reader's state and phone title stay whole ([#4125](https://github.com/k2b-dev/cloud/issues/4125)) ([d69b391](https://github.com/k2b-dev/cloud/commit/d69b391071273df3a53dc85421f07b45da5a4595))
* **weather:** weather runs on UI v2 ([#4179](https://github.com/k2b-dev/cloud/issues/4179)) ([4b89441](https://github.com/k2b-dev/cloud/commit/4b894410c73fe340308c8341ce65dc9f71a690f9))


### Bug Fixes

* **ci:** unit shards are planned from current test times again ([#4114](https://github.com/k2b-dev/cloud/issues/4114)) ([7af8464](https://github.com/k2b-dev/cloud/commit/7af8464208552a19d52c7be865221d439c07d209))
* **ci:** unit shards balance by fresh measured times, and the slowest suites split ([#4404](https://github.com/k2b-dev/cloud/issues/4404)) ([723464e](https://github.com/k2b-dev/cloud/commit/723464eb40fde2c9b94247f5296973995f181268))
* **cloud:** concurrent index builds start in the background and never hold startup ([#4489](https://github.com/k2b-dev/cloud/issues/4489)) ([b6fa259](https://github.com/k2b-dev/cloud/commit/b6fa25903c0899acf3aab8cb0867b48d4de0e0a8))
* **cloud:** no icon stands as an empty box for a filled Tabler name ([#4560](https://github.com/k2b-dev/cloud/issues/4560)) ([e79bd17](https://github.com/k2b-dev/cloud/commit/e79bd1790c386970d9973923a0047774c471822f))
* **test:** session origin posts wait for the page they navigate to before the next read ([#4469](https://github.com/k2b-dev/cloud/issues/4469)) ([7a7a454](https://github.com/k2b-dev/cloud/commit/7a7a4548f6f238bd68cce3c91225ab6f75283dd4))
* **ui:** a v2 nav without a tree and a menu without a panel load none of their code ([#4449](https://github.com/k2b-dev/cloud/issues/4449)) ([89e179c](https://github.com/k2b-dev/cloud/commit/89e179c886739502b065adbcdc954fee1faca9b9))
* **ui:** status row parts, segments and section actions give way without losing words or names ([#4221](https://github.com/k2b-dev/cloud/issues/4221)) ([70eb6d7](https://github.com/k2b-dev/cloud/commit/70eb6d748a48ebe89b603d6047deb5a43c776a8e))
* **ui:** the island error fallback loads only its own modules, not the button, marks and states of every app ([#4333](https://github.com/k2b-dev/cloud/issues/4333)) ([35ee1f6](https://github.com/k2b-dev/cloud/commit/35ee1f6e3ded87a8590a9348c77dbebd584527ce))
* **weather:** one person saves at most 100 places, and a place page asks their forecasts a few at a time ([#4550](https://github.com/k2b-dev/cloud/issues/4550)) ([36f7abb](https://github.com/k2b-dev/cloud/commit/36f7abb84fe93c09bb1fcc36de7b6bd8a23c543c))


### Performance Improvements

* **cloud:** a long v2 navigation weighs on a page by its first 40 entries, and on an island only once its menu opens ([#4387](https://github.com/k2b-dev/cloud/issues/4387)) ([31f50f1](https://github.com/k2b-dev/cloud/commit/31f50f167cf838047fc91d5badc0cdf2b50e9ee0))
* **cloud:** an island takes only what it uses from @k2b/cloud, also through the islands barrel ([#4441](https://github.com/k2b-dev/cloud/issues/4441)) ([1e3788d](https://github.com/k2b-dev/cloud/commit/1e3788d30480d94ab67be430f5ced72d3f61f643))
* **core:** logs by source and recent workflow runs read through indexes of their own ([#4481](https://github.com/k2b-dev/cloud/issues/4481)) ([f2eaf02](https://github.com/k2b-dev/cloud/commit/f2eaf02ecd65514752ad84622fbee2cecbdaed77))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ssr bumped from 0.23.2 to 0.24.0
    * @k2b/ui bumped from 0.66.0 to 0.67.0
    * @k2b/stdlib bumped from 0.36.1 to 0.37.0
    * @k2b/editor bumped from 0.15.1 to 0.16.0
</details>

<details><summary>cloud: 0.87.0</summary>

## [0.87.0](https://github.com/k2b-dev/cloud/compare/cloud-v0.86.0...cloud-v0.87.0) (2026-11-28)


###   BREAKING CHANGES

* **faq:** Before upgrading, export entries with the old running application using cld --profile ADMIN_PROFILE faq list --json > faq-export.json. Core permanently drops the faq schema and its entries. A restarted old FAQ container recreates an empty schema, so remove its automatic restart/deployment configuration first. After upgrade, recovery requires a pre-upgrade export/backup. Copy content into Notebook notes if needed; review sharing/languages. Help does not import entries automatically. Remove the cached faq CLI plugin after exporting and update old URLs/integrations. Stop/remove app-faq with the previous deployment configuration, remove its workload/service/key mount, and wait at least three minutes before upgrading Core. Core deletes remembered registry/package records, app keys and service accounts with their grants, application access, settings/domains, rail and chooser/consent preferences, notifications and deliveries, approvals and remembered approval grants, Help/search documents and Skill catalogs, app-owned Code, workflow runs/scopes and AI admission/budget state, event subscriptions/outbox data, and the app's own provider execution/idempotency records. Explicit retired-app grants in non-revoked mandates are pruned and affected active mandates are paused and audited. Historical audit events, AI inference/quota and structured-run records, outgoing-mail messages, logging and other providers' capability executions remain, including executions called through the removed app. An app.removed audit is written only when rows are removed or changed, with separate deletion/change counts; fresh installations get no event. Revoked mandates owned by other apps stay unchanged. Dependent cascades are additional. Other apps' data stays. Cleanup can extend Core startup on large installations; wait for Core readiness.
* **capabilities:** The inspector had no owned schema or authored content, so there is no application export command. Back up the database first if removed operational records are needed. The platform capabilities schema/API/CLI and provider applications stay; update old inspector links and catalog-search integrations. Stop/remove app-capabilities with the previous deployment configuration, remove its workload/service/key mount, and wait at least three minutes before upgrading Core. Core deletes remembered registry/package records, app keys and service accounts with their grants, application access, settings/domains, rail and chooser/consent preferences, notifications and deliveries, approvals and remembered approval grants, Help/search documents and Skill catalogs, app-owned Code, workflow runs/scopes and AI admission/budget state, event subscriptions/outbox data, and the app's own provider execution/idempotency records. Explicit retired-app grants in non-revoked mandates are pruned and affected active mandates are paused and audited. Historical audit events, AI inference/quota and structured-run records, outgoing-mail messages, logging and other providers' capability executions remain, including executions called through the removed app. An app.removed audit is written only when rows are removed or changed, with separate deletion/change counts; fresh installations get no event. Revoked mandates owned by other apps stay unchanged. Dependent cascades are additional. Other apps' data stays. Cleanup can extend Core startup on large installations; wait for Core readiness.
* **stdlib:** @k2b/stdlib no longer exports `charts`, `scatter`, `line`, `bar`, `pie`, `donut`, `sparkline`, `histogram`, `boxplot`, `gauge`, `barGauge`, `stat`, `heatmap`, `map`, `stateTimeline`, `chartDatumSvg`, `svgRoot`, `escapeXml`, `normalizePadding`, `computeDomain`, `niceStep`, `extendDomainToNice`, `mapRange`, `mapLog`, `niceLogTicks`, `linearRegression`, `computeBoxStats`, `autoBin`, `linePathD`, `smoothPathD`, `arcPathD`, `markerPath`, `stepPathD` or the types `Point`, `Series`, `MarkerShape`, `LineStyle`, `MapPoint`, `MapSeries`, `MapViewport`, `MapOptions`, `BarItem`, `SliceItem`, `AxisOptions`, `Padding`, `ChartDatum`, `ChartOptions`, `ReferenceLine`. Replacement: render with `Chart` from `@k2b/ui/charts`, or import the same names from `@k2b/ui/charts/core`, which keeps their signatures and markup.

### Features

* **accounts:** an agent's page shows its API keys and creates and revokes them on v2 ([#4110](https://github.com/k2b-dev/cloud/issues/4110)) ([a1d7969](https://github.com/k2b-dev/cloud/commit/a1d79695ec9bb604d607f48766f6fcae9a22807e))
* **accounts:** users and groups filter, sort and group in the URL on v2 ([#4156](https://github.com/k2b-dev/cloud/issues/4156)) ([e07318c](https://github.com/k2b-dev/cloud/commit/e07318c3af4ce02ae863d06008d7ed3d01d10611))
* **capabilities:** the capabilities app is removed ([#4176](https://github.com/k2b-dev/cloud/issues/4176)) ([d350dee](https://github.com/k2b-dev/cloud/commit/d350deeb0f9bc038866e092d17a0bb87c8e9913d))
* **chat:** the chat page runs on UI v2 ([#4362](https://github.com/k2b-dev/cloud/issues/4362)) ([a337b00](https://github.com/k2b-dev/cloud/commit/a337b000350e1bec883e9b841b0ded67b2f45ee0))
* **chat:** v2 chats stand in the nav, and a place's discussions are cards in its stream that open in its place ([#4531](https://github.com/k2b-dev/cloud/issues/4531)) ([4d68a6f](https://github.com/k2b-dev/cloud/commit/4d68a6f8907c4cf13ecc1f88fbb2168ef4d1e52d))
* **cloud:** a panel page can be built with @k2b/ui/v2 (PanelLayout ui="v2") ([#4311](https://github.com/k2b-dev/cloud/issues/4311)) ([63e2aec](https://github.com/k2b-dev/cloud/commit/63e2aec8e478f2c5a086f1cfdd13f0ed96bcd73c))
* **cloud:** a v2 principal picker, and the v2 permission editor adds with it ([#4415](https://github.com/k2b-dev/cloud/issues/4415)) ([98a7649](https://github.com/k2b-dev/cloud/commit/98a7649b24a742400370f79f40f30c2b1c9314f5))
* **cloud:** admin pages can run on UI v2 with their sidebar ([#4169](https://github.com/k2b-dev/cloud/issues/4169)) ([21d37ed](https://github.com/k2b-dev/cloud/commit/21d37edce1b88af29f0a1f447b9374b85636583c))
* **cloud:** applications count the members of the reader's own groups ([#4304](https://github.com/k2b-dev/cloud/issues/4304)) ([d4a03ab](https://github.com/k2b-dev/cloud/commit/d4a03ab641251463b2aa3588874f8cc94271cc6c))
* **cloud:** islands load one module of @k2b/cloud/shared and no v1 code for their error fallback ([#4242](https://github.com/k2b-dev/cloud/issues/4242)) ([03700a1](https://github.com/k2b-dev/cloud/commit/03700a1b938de5edd6f6d7eeaa8bac7f417f9f38))
* **cloud:** on the phone a v2 page's search sits in the shell's phone bar ([#4162](https://github.com/k2b-dev/cloud/issues/4162)) ([73e08c0](https://github.com/k2b-dev/cloud/commit/73e08c096c54650e7a3a7edea5326f3444233c06))
* **cloud:** the access dialog opens on UI v2 from v2 pages ([#4207](https://github.com/k2b-dev/cloud/issues/4207)) ([f7bcbd2](https://github.com/k2b-dev/cloud/commit/f7bcbd2208afe53eddc576e5a0d1c56ac52d26c9))
* **cloud:** the access summary and dialog show faces and marks on UI v2 ([#4222](https://github.com/k2b-dev/cloud/issues/4222)) ([67a729a](https://github.com/k2b-dev/cloud/commit/67a729a937f9b320fa91dda7eca4430b3491f3e5))
* **cloud:** v2 visitor pages load Core's v2.css alone ([#4231](https://github.com/k2b-dev/cloud/issues/4231)) ([1be3596](https://github.com/k2b-dev/cloud/commit/1be359605e203e56565233e97ca391502aa0f6fd))
* **cloud:** visitor pages render on UI v2 with MinimalLayout ui v2 ([#4227](https://github.com/k2b-dev/cloud/issues/4227)) ([29e506b](https://github.com/k2b-dev/cloud/commit/29e506b27a83177e0f30642485325920e6e4482c))
* **core:** /admin opens the operations overview, or Apps without it, instead of a start page of its own ([#4541](https://github.com/k2b-dev/cloud/issues/4541)) ([7625f20](https://github.com/k2b-dev/cloud/commit/7625f200be51ef66c799d2da103adb0930479ad2))
* **core:** account pages and pairing run on UI v2 with one account and one activity ([#4173](https://github.com/k2b-dev/cloud/issues/4173)) ([2754b0f](https://github.com/k2b-dev/cloud/commit/2754b0fc702f6595639c6db3fedd1ed1fb0ffc0c))
* **core:** AI and Code administration run on UI v2 ([#4396](https://github.com/k2b-dev/cloud/issues/4396)) ([af8b9d9](https://github.com/k2b-dev/cloud/commit/af8b9d948932d89a0e31eda877326b1a688c0882))
* **core:** Core administration runs on UI v2 ([#4174](https://github.com/k2b-dev/cloud/issues/4174)) ([9e1f7b1](https://github.com/k2b-dev/cloud/commit/9e1f7b1d491105630d48873b98a5f8db2710a728))
* **docs:** Fibel shows UI v2 as topic pages with live examples, code and generated props ([#4142](https://github.com/k2b-dev/cloud/issues/4142)) ([a6e0af3](https://github.com/k2b-dev/cloud/commit/a6e0af375dfa523bc2304729da9af6793241540c))
* **faq:** the FAQ app is removed ([#4178](https://github.com/k2b-dev/cloud/issues/4178)) ([4964b1f](https://github.com/k2b-dev/cloud/commit/4964b1f40b8cd69648e15fe4967d98e3cd45abc9))
* **gateway-ops:** a log entry shows only its request in one step ([#4180](https://github.com/k2b-dev/cloud/issues/4180)) ([7ebf051](https://github.com/k2b-dev/cloud/commit/7ebf05158f7bb670123572d75ca870f2ef1d588b))
* **gateway-ops:** infrastructure and settings records and the service pages run on UI v2 ([#4171](https://github.com/k2b-dev/cloud/issues/4171)) ([8cc6fc3](https://github.com/k2b-dev/cloud/commit/8cc6fc30f29c02a9f636370d6617dd35272b0aaa))
* **gateway-ops:** logs filter, group and keep their view in the URL on v2 ([#4137](https://github.com/k2b-dev/cloud/issues/4137)) ([31b7ebd](https://github.com/k2b-dev/cloud/commit/31b7ebd14a4b7780dd024d56da7b04a5892aab82))
* **grids:** a table counts its records and its new records per day ([#4379](https://github.com/k2b-dev/cloud/issues/4379)) ([2ee2651](https://github.com/k2b-dev/cloud/commit/2ee26510ac49e8b07d0c6ca6bb42ea10a0f6c66b))
* **grids:** numbers and dates read in the reader's language ([#4374](https://github.com/k2b-dev/cloud/issues/4374)) ([620f91a](https://github.com/k2b-dev/cloud/commit/620f91a1bdd12664e3f6fc194efef72e7fda794d))
* **grids:** workflow run stats carry a bounded time series ([#4347](https://github.com/k2b-dev/cloud/issues/4347)) ([3fc6db2](https://github.com/k2b-dev/cloud/commit/3fc6db25d8a02b9d147c18f3af91fd12b10e9b10))
* **mail:** attachments are a read-only source in the file chooser ([#4479](https://github.com/k2b-dev/cloud/issues/4479)) ([52af044](https://github.com/k2b-dev/cloud/commit/52af044cae0e2b42430524482a723d9510c0b243))
* **mail:** later and remind me offer times in a submenu and pick any date from a calendar ([#4157](https://github.com/k2b-dev/cloud/issues/4157)) ([84c3397](https://github.com/k2b-dev/cloud/commit/84c3397484c1ebaf3cefeb86a7fb6ff6f2134c91))
* **mail:** Mail's list and reader are built on @k2b/ui v2 behind a pilot setting ([#4104](https://github.com/k2b-dev/cloud/issues/4104)) ([d4cddb9](https://github.com/k2b-dev/cloud/commit/d4cddb914fa7452e0cd69737dacc2fdab01057d1))
* **mail:** processing existing mail is a step of the mailbox's Code page ([#4490](https://github.com/k2b-dev/cloud/issues/4490)) ([790afb0](https://github.com/k2b-dev/cloud/commit/790afb0e9c055d48dcdc66fcd959741d10d5bdd4))
* **mail:** the empty v2 reader shows the mails received per day of the last year ([#4448](https://github.com/k2b-dev/cloud/issues/4448)) ([3e3259a](https://github.com/k2b-dev/cloud/commit/3e3259aef79c4b00ef5f44760fb4652c60d9d883))
* **mail:** the later calendar takes the place of the times and starts at an offered time ([#4249](https://github.com/k2b-dev/cloud/issues/4249)) ([ec5c3a5](https://github.com/k2b-dev/cloud/commit/ec5c3a5a0b16670ad6b8e1cb4f21969e22958618))
* **mail:** the retired rules' history is a readable step of the mailbox's Code page ([#4503](https://github.com/k2b-dev/cloud/issues/4503)) ([d41d472](https://github.com/k2b-dev/cloud/commit/d41d4724d2628b4a1d8d4e47b725abb2cf5b7f8b))
* **mail:** Use as new opens the draft as a window over the mailbox ([#4559](https://github.com/k2b-dev/cloud/issues/4559)) ([15aafc2](https://github.com/k2b-dev/cloud/commit/15aafc2cc0caf2ce0c99604283e08b41aa8ecc5d))
* **notebooks:** a note's backlinks come one page at a time with their total ([#4422](https://github.com/k2b-dev/cloud/issues/4422)) ([0475e18](https://github.com/k2b-dev/cloud/commit/0475e1816dc7fe08c0f64180ce4a96e0941be576))
* **oauth:** administrators disconnect one person or everyone from a client ([#4371](https://github.com/k2b-dev/cloud/issues/4371)) ([bd2380d](https://github.com/k2b-dev/cloud/commit/bd2380d3741d96d809a008828b66bfbe84f4be08))
* **proxy-auth:** Proxy Auth runs on UI v2 ([#4246](https://github.com/k2b-dev/cloud/issues/4246)) ([1048509](https://github.com/k2b-dev/cloud/commit/10485091dc54ab096d845d54f4311df717223ba5))
* **speedtest:** the public speed test runs on UI v2 ([#4170](https://github.com/k2b-dev/cloud/issues/4170)) ([70fbe4a](https://github.com/k2b-dev/cloud/commit/70fbe4a0cbe0a3e6974dc592bdcea9ac5514da17))
* **ssr:** island props travel in a comment instead of an escaped attribute ([#4510](https://github.com/k2b-dev/cloud/issues/4510)) ([8b24085](https://github.com/k2b-dev/cloud/commit/8b240854cfb5ab2d21175f753cb23768111dcba0))
* **stdlib:** charts live only in @k2b/ui/charts ([#4143](https://github.com/k2b-dev/cloud/issues/4143)) ([276ef71](https://github.com/k2b-dev/cloud/commit/276ef71df312eaba3f71707914aeb8dd4eb995c8))
* **tools:** the Tools catalog and its text, code and security tools run on UI v2 ([#4186](https://github.com/k2b-dev/cloud/issues/4186)) ([f9b9d7a](https://github.com/k2b-dev/cloud/commit/f9b9d7ae8435318f492612a81e580cec1980de28))
* **ui:** a calendar in a v2 Canvas lies flat instead of drawing a card ([#4365](https://github.com/k2b-dev/cloud/issues/4365)) ([32eb7c5](https://github.com/k2b-dev/cloud/commit/32eb7c52bdba40685e1724363f0b9932a03ac8cb))
* **ui:** a compact Prose shows short text a person wrote as text, without tables or large headings ([#4382](https://github.com/k2b-dev/cloud/issues/4382)) ([38b466c](https://github.com/k2b-dev/cloud/commit/38b466c8d0893e192688b24ca9e6a8867efc8415))
* **ui:** a context column stands beside its main column only where there is room, and a detail grows to two columns on a large screen ([#4340](https://github.com/k2b-dev/cloud/issues/4340)) ([ae50d4f](https://github.com/k2b-dev/cloud/commit/ae50d4f4396cdb6ae26357b296abb5c2ea3b1bdc))
* **ui:** a heat calendar shows a year of days in tones of one colour ([#4445](https://github.com/k2b-dev/cloud/issues/4445)) ([1fba4de](https://github.com/k2b-dev/cloud/commit/1fba4decd89772f1157c0c2c2b4526db0f14e3a6))
* **ui:** a line chart takes quiet bands, a colour scale for its line, and a track of bars under it ([#4461](https://github.com/k2b-dev/cloud/issues/4461)) ([0ffa797](https://github.com/k2b-dev/cloud/commit/0ffa797afdffc8080d10ab2e203761ba0fe12f4e))
* **ui:** a long title in a detail's head takes two lines, with its full words as a tooltip ([#4257](https://github.com/k2b-dev/cloud/issues/4257)) ([e110b6b](https://github.com/k2b-dev/cloud/commit/e110b6bcf9a07cf3f55482c1e23afde84416134f))
* **ui:** a pane's head and its toolbar are one block, a head's search is its symbol, and a row keeps its time beside its deed ([#4537](https://github.com/k2b-dev/cloud/issues/4537)) ([0525fcd](https://github.com/k2b-dev/cloud/commit/0525fcd4b2178fe041b780e77f16f42f74239655))
* **ui:** a state timeline marks now, keeps runs of seconds visible, and draws planned runs as outlines ([#4344](https://github.com/k2b-dev/cloud/issues/4344)) ([68bb47a](https://github.com/k2b-dev/cloud/commit/68bb47a5199c1cd9f9bb2a8525a31b47f9d0c986))
* **ui:** a status row lead gives way first and keeps its words as hint, its statement carries tinted chips, and measureV2Layout finds text under its neighbour ([#4259](https://github.com/k2b-dev/cloud/issues/4259)) ([dd5ac30](https://github.com/k2b-dev/cloud/commit/dd5ac30cdf70a71ec84106e6e04c9d59d26b1b02))
* **ui:** a v2 bar folds the end's buttons that do not fit into a menu, and its start gives way down to its least ([#4392](https://github.com/k2b-dev/cloud/issues/4392)) ([af69ef8](https://github.com/k2b-dev/cloud/commit/af69ef8f8f30bbfbc0ab8e3ac2bef11cf4615045))
* **ui:** a v2 button can be a toggle that is pressed, such as a favourite star ([#4122](https://github.com/k2b-dev/cloud/issues/4122)) ([6209b4a](https://github.com/k2b-dev/cloud/commit/6209b4a9ede5b36057999d7115efbe22e31b1f84))
* **ui:** a v2 Canvas can be the whole pane, its drawing scrolls inside and what stands under it stays in sight ([#4356](https://github.com/k2b-dev/cloud/issues/4356)) ([b42f1cb](https://github.com/k2b-dev/cloud/commit/b42f1cb52c1a11af14abd720fe8ead241bf617aa))
* **ui:** a v2 date picker for a moment ahead shows six weeks from this week ([#4252](https://github.com/k2b-dev/cloud/issues/4252)) ([0973625](https://github.com/k2b-dev/cloud/commit/0973625044b9c83755588b2692dfe3535c20b211))
* **ui:** a v2 empty state can show that something went wrong or waits ([#4323](https://github.com/k2b-dev/cloud/issues/4323)) ([4a22492](https://github.com/k2b-dev/cloud/commit/4a2249203ea6f1b8c91911827d3c1513ee9a592e))
* **ui:** a v2 head search sends its text to the server without JavaScript ([#4279](https://github.com/k2b-dev/cloud/issues/4279)) ([3edff0f](https://github.com/k2b-dev/cloud/commit/3edff0f809ac352eb4d1030c12f3eb154c19d6a8))
* **ui:** a v2 link button can download, and addressOf is public ([#4412](https://github.com/k2b-dev/cloud/issues/4412)) ([3e73e47](https://github.com/k2b-dev/cloud/commit/3e73e4770c76a45e81b8d2b34990607381f41a0c))
* **ui:** a v2 menu entry can carry a data colour as a dot before its words ([#4457](https://github.com/k2b-dev/cloud/issues/4457)) ([9d05e36](https://github.com/k2b-dev/cloud/commit/9d05e3622b33c194af32a1c8ddc183d9d0d89cdb))
* **ui:** a v2 nav holds a search, a main action and an app's own list, which is the phone's page ([#4443](https://github.com/k2b-dev/cloud/issues/4443)) ([d9714e7](https://github.com/k2b-dev/cloud/commit/d9714e7dcd9cddaef0434766f3bb448a95d322b2))
* **ui:** a v2 notice can name its one thing to do as its primary deed ([#4298](https://github.com/k2b-dev/cloud/issues/4298)) ([e871206](https://github.com/k2b-dev/cloud/commit/e87120649d9d6e768f73044f5be3515b4c87a14a))
* **ui:** a v2 page can take its accent from data, with readable ink ([#4567](https://github.com/k2b-dev/cloud/issues/4567)) ([e7123d5](https://github.com/k2b-dev/cloud/commit/e7123d586a704025ea97149a2433ad3e0c98bf5f))
* **ui:** a v2 pane without a head names itself after its way back on the phone ([#4296](https://github.com/k2b-dev/cloud/issues/4296)) ([ea831a3](https://github.com/k2b-dev/cloud/commit/ea831a3ff707b3a41bfe620f3be68159316a2ae7))
* **ui:** a v2 RangeBar shows a range on a shared scale, and a v2 icon takes a data colour ([#4442](https://github.com/k2b-dev/cloud/issues/4442)) ([f34ea3d](https://github.com/k2b-dev/cloud/commit/f34ea3dcfef792aea291ae35f7bbc644cfd58589))
* **ui:** a v2 row stands at a level in a flat list ([#4427](https://github.com/k2b-dev/cloud/issues/4427)) ([d759624](https://github.com/k2b-dev/cloud/commit/d7596240e4e9281b2b4a7bc001e936509480e0b6))
* **ui:** a v2 row's deed is named by its words and then the row's title ([#4307](https://github.com/k2b-dev/cloud/issues/4307)) ([4876812](https://github.com/k2b-dev/cloud/commit/4876812fb1483e50ee68b5d5d672eaf989603ee4))
* **ui:** a v2 section can keep its content to the reading measure ([#4320](https://github.com/k2b-dev/cloud/issues/4320)) ([2525750](https://github.com/k2b-dev/cloud/commit/252575060e264db759bbebee7ec4d08d1daec517))
* **ui:** a v2 sidebar entry shows work that runs in the place of its dot ([#4281](https://github.com/k2b-dev/cloud/issues/4281)) ([e8967cd](https://github.com/k2b-dev/cloud/commit/e8967cd31e00e19dcbfcfe19ef8f399c3763e34d))
* **ui:** a v2 state can be quiet, its dot and word without the tinted round ([#4326](https://github.com/k2b-dev/cloud/issues/4326)) ([2e06496](https://github.com/k2b-dev/cloud/commit/2e064964a44a4ba4c0a9bf2956bdfc7a17899232))
* **ui:** a v2 status row drops its figures when narrow and reserves a loading mark; phone rows end in a status ([#4139](https://github.com/k2b-dev/cloud/issues/4139)) ([fa6f5b7](https://github.com/k2b-dev/cloud/commit/fa6f5b7949e95fbfa82f52b752b8dacca300ac38))
* **ui:** after a touch on a v2 table head its column grips take a 44 px target, and a focus in the head shows them ([#4435](https://github.com/k2b-dev/cloud/issues/4435)) ([1ed5465](https://github.com/k2b-dev/cloud/commit/1ed5465021cbd2ab9c6940852d6a402cfac66aac))
* **ui:** people's faces spread over eleven hues that stay readable and apart, also for colour-blind people ([#4530](https://github.com/k2b-dev/cloud/issues/4530)) ([6a644ae](https://github.com/k2b-dev/cloud/commit/6a644ae24f39c75110c11526d7e71cf34cde9532))
* **ui:** the Markdown editors' toolbars follow v2 inside a v2 screen ([#4243](https://github.com/k2b-dev/cloud/issues/4243)) ([1c7cdec](https://github.com/k2b-dev/cloud/commit/1c7cdec5fe997738fabc8a30c7abd32a5c96f187))
* **ui:** the v2 date picker takes its time from the ui-sdk time input ([#4224](https://github.com/k2b-dev/cloud/issues/4224)) ([06c28c6](https://github.com/k2b-dev/cloud/commit/06c28c6aee3115036e5f0b81b4ccf5c30e2071d1))
* **ui:** the v2 dialog, a sheet on the phone, Dialog.confirm, and a Select that is a form field ([#4106](https://github.com/k2b-dev/cloud/issues/4106)) ([30f04ae](https://github.com/k2b-dev/cloud/commit/30f04ae642785212a7b4265011595c9cd8f0ec9f))
* **ui:** the v2 primary action takes its app's main colour, plum for the assistant ([#4297](https://github.com/k2b-dev/cloud/issues/4297)) ([d341768](https://github.com/k2b-dev/cloud/commit/d341768a7b6068bba751633f9b542a15de19e3ac))
* **ui:** the v2 sidebar becomes a drawer where it no longer fits beside the columns ([#4123](https://github.com/k2b-dev/cloud/issues/4123)) ([d843aab](https://github.com/k2b-dev/cloud/commit/d843aabebcab674cfd5baed650def188b0df4c2b))
* **ui:** Ticks show one state per time slot, ok soft in the app colour and a failure red ([#4353](https://github.com/k2b-dev/cloud/issues/4353)) ([4f6229f](https://github.com/k2b-dev/cloud/commit/4f6229f00c0707f7e9e5c3a17fb91c4c1b01b8f3))
* **ui:** v2 a first start stands in the middle of the page, with tiles that share a row ([#4477](https://github.com/k2b-dev/cloud/issues/4477)) ([64b0c8a](https://github.com/k2b-dev/cloud/commit/64b0c8ac42f1ac5c31a807603a3aea9f43692d8c))
* **ui:** v2 a start card previews what it makes and opens it with one press ([#4505](https://github.com/k2b-dev/cloud/issues/4505)) ([18db15b](https://github.com/k2b-dev/cloud/commit/18db15b7e9269ac19a9894b78dead196a8a32656))
* **ui:** v2 address chips, named chip removal, and a phone sheet with grip and close ([#4273](https://github.com/k2b-dev/cloud/issues/4273)) ([6a02921](https://github.com/k2b-dev/cloud/commit/6a029212c015e9b1e4f592bd7a466e31ea170733))
* **ui:** v2 avatars show pictures, tables sort by their heads, and buttons and fields know busy and disabled ([#4116](https://github.com/k2b-dev/cloud/issues/4116)) ([6600a52](https://github.com/k2b-dev/cloud/commit/6600a5298c99f890522dd678f705270785913885))
* **ui:** v2 choices show faces and take several, sliders read a unit, selects keep an address's domain ([#4267](https://github.com/k2b-dev/cloud/issues/4267)) ([829441b](https://github.com/k2b-dev/cloud/commit/829441b431d82dc3cdd38b88fb9cd61aaafa8baa))
* **ui:** v2 column grip runs on the ui-sdk Resizable ([#4105](https://github.com/k2b-dev/cloud/issues/4105)) ([959e6cd](https://github.com/k2b-dev/cloud/commit/959e6cda771d412c38fc55784298541d349b9244))
* **ui:** v2 controls get keyboard, focus and drag behaviour from the ui-sdk core ([#4053](https://github.com/k2b-dev/cloud/issues/4053)) ([c4568da](https://github.com/k2b-dev/cloud/commit/c4568da2b2dbf16a6a85907a3682089940f0c703))
* **ui:** v2 dates are picked from a calendar, and a filter's own period opens it as a submenu ([#4159](https://github.com/k2b-dev/cloud/issues/4159)) ([d57291e](https://github.com/k2b-dev/cloud/commit/d57291e50bb749778736a56f10d37ea27fc00a0b))
* **ui:** v2 drag onto a target holds touch through the ui-sdk core ([#4107](https://github.com/k2b-dev/cloud/issues/4107)) ([f6e9ff3](https://github.com/k2b-dev/cloud/commit/f6e9ff349b372d94e20f912607e56f66d0985690))
* **ui:** v2 forms offer tags, images, codes, disabled choices, field actions and disclosures ([#4191](https://github.com/k2b-dev/cloud/issues/4191)) ([fef72a0](https://github.com/k2b-dev/cloud/commit/fef72a07be09533a914ebbbe6729befa8bdc262d))
* **ui:** v2 head controls stay on the phone, and only the floating button's twin and a detail's close leave the head ([#4373](https://github.com/k2b-dev/cloud/issues/4373)) ([edaab8e](https://github.com/k2b-dev/cloud/commit/edaab8e76c74ede8b5ff40ada00f6a16420a92b5))
* **ui:** v2 head popovers stay on the phone and facts load in their shape ([#4164](https://github.com/k2b-dev/cloud/issues/4164)) ([8f56b22](https://github.com/k2b-dev/cloud/commit/8f56b2226d6f67a783923c7e81ef2a6a84cfa638))
* **ui:** v2 listbox, tree and per-owner toasts on the ui-sdk core ([#4108](https://github.com/k2b-dev/cloud/issues/4108)) ([8d10b20](https://github.com/k2b-dev/cloud/commit/8d10b2071f473a0401bb8218d7ba4ba14f9d4984))
* **ui:** v2 lists declare their filters, sorts and groups and keep them in the URL ([#4135](https://github.com/k2b-dev/cloud/issues/4135)) ([e0e8c69](https://github.com/k2b-dev/cloud/commit/e0e8c695b2cd8e83361d14f305db8794c1c02813))
* **ui:** v2 lists show their filters as readable statements and pick values asynchronously ([#4136](https://github.com/k2b-dev/cloud/issues/4136)) ([7d89bce](https://github.com/k2b-dev/cloud/commit/7d89bceb519a6f92b17f8d7eeaf6f47ad4292854))
* **ui:** v2 menus, popovers and toasts ([#4109](https://github.com/k2b-dev/cloud/issues/4109)) ([99b941d](https://github.com/k2b-dev/cloud/commit/99b941d93d6e1d58e4c7738f4f86e0cae06997ae))
* **ui:** v2 navigation and tables show trees ([#4187](https://github.com/k2b-dev/cloud/issues/4187)) ([4fca75e](https://github.com/k2b-dev/cloud/commit/4fca75ebda3681c9170b37b31edbddd00938512c))
* **ui:** v2 pages announce state changes to assistive technology through one live region ([#4341](https://github.com/k2b-dev/cloud/issues/4341)) ([8d5566d](https://github.com/k2b-dev/cloud/commit/8d5566d8ac48439c44f254a8422ca0144de96bd3))
* **ui:** v2 RangeBar shows several ranges in one row ([#4553](https://github.com/k2b-dev/cloud/issues/4553)) ([4d91e8e](https://github.com/k2b-dev/cloud/commit/4d91e8e6fd12110370c88f4481274e0c26d52fc1))
* **ui:** v2 Rating lets people rate with 1 to 5 stars ([#4555](https://github.com/k2b-dev/cloud/issues/4555)) ([e6422ea](https://github.com/k2b-dev/cloud/commit/e6422eaee7e5e5b2912f1c0a91b4240fc2ac8f75))
* **ui:** v2 rows part with a quiet line, and the open row takes the tint of the app it belongs to ([#4355](https://github.com/k2b-dev/cloud/issues/4355)) ([0190356](https://github.com/k2b-dev/cloud/commit/01903569451c0088cba04fe66356fe20beb3c502))
* **ui:** v2 rows show they are selected and an open detail on the phone has one way back ([#4111](https://github.com/k2b-dev/cloud/issues/4111)) ([bcf947a](https://github.com/k2b-dev/cloud/commit/bcf947a74e8bce5aedc1ac9398699ba1ee6cc300))
* **ui:** v2 sidebar and tab counts are written in the page's language, in full ([#4254](https://github.com/k2b-dev/cloud/issues/4254)) ([405ff88](https://github.com/k2b-dev/cloud/commit/405ff88abe29ec78703be9709c8bb51b154d656b))
* **ui:** v2 sparks side by side share one scale with max ([#4527](https://github.com/k2b-dev/cloud/issues/4527)) ([319a184](https://github.com/k2b-dev/cloud/commit/319a184982ecbd475ba145ba327785f72815e25f))
* **ui:** v2 table names give way to their marks, measureV2Layout sees controls that stick out, and a list section can fold ([#4366](https://github.com/k2b-dev/cloud/issues/4366)) ([87a9566](https://github.com/k2b-dev/cloud/commit/87a956610d34ed90cddd73cdd75b394cd7af1668))
* **ui:** v2 tabs open their menu, sidebars fold and carry deeds, and a reader's state and phone title stay whole ([#4125](https://github.com/k2b-dev/cloud/issues/4125)) ([d69b391](https://github.com/k2b-dev/cloud/commit/d69b391071273df3a53dc85421f07b45da5a4595))
* **ui:** v2 things and people show their face ([#4208](https://github.com/k2b-dev/cloud/issues/4208)) ([0180631](https://github.com/k2b-dev/cloud/commit/018063197b24d51dbc49c0af12cf760d9cf941bb))
* **venue:** the venue list returns pages of 100, newest first, with a name search, and the CLI, switcher and overview page through it ([#4533](https://github.com/k2b-dev/cloud/issues/4533)) ([0094153](https://github.com/k2b-dev/cloud/commit/0094153a1dd988d1e2f4c2ce9b154bbff406fcc5))
* **weather:** weather runs on UI v2 ([#4179](https://github.com/k2b-dev/cloud/issues/4179)) ([4b89441](https://github.com/k2b-dev/cloud/commit/4b894410c73fe340308c8341ce65dc9f71a690f9))


### Bug Fixes

* **accounts:** remove values no page reads ([#4400](https://github.com/k2b-dev/cloud/issues/4400)) ([3668b49](https://github.com/k2b-dev/cloud/commit/3668b492cd8a50f6ed32e6f17112c63110970b25))
* **checks:** toast-copy checks v2 toasts by their one-sentence contract ([#4201](https://github.com/k2b-dev/cloud/issues/4201)) ([070c9fe](https://github.com/k2b-dev/cloud/commit/070c9fe20e61676a826c5ae93a3a9f1730c010b2))
* **ci:** draft pull requests run a light check so the merge queue gets runners first ([#4215](https://github.com/k2b-dev/cloud/issues/4215)) ([56efeef](https://github.com/k2b-dev/cloud/commit/56efeefc34f9d63bd4c697418e12384ca282551b))
* **ci:** the nightly Grids and Chat smokes send their mutations from the public origin ([#4097](https://github.com/k2b-dev/cloud/issues/4097)) ([6ef25af](https://github.com/k2b-dev/cloud/commit/6ef25af3832de9173a55b02d44dd2e7c40999ea2))
* **ci:** unit shards are planned from current test times again ([#4114](https://github.com/k2b-dev/cloud/issues/4114)) ([7af8464](https://github.com/k2b-dev/cloud/commit/7af8464208552a19d52c7be865221d439c07d209))
* **ci:** unit shards balance by fresh measured times, and the slowest suites split ([#4404](https://github.com/k2b-dev/cloud/issues/4404)) ([723464e](https://github.com/k2b-dev/cloud/commit/723464eb40fde2c9b94247f5296973995f181268))
* **ci:** WebKit shards plan by fresh measured times, in twenty-five shards ([#4474](https://github.com/k2b-dev/cloud/issues/4474)) ([efe7765](https://github.com/k2b-dev/cloud/commit/efe7765603cad74d0c88ba1ffb137f9a6d778c7f))
* **cloud:** concurrent index builds start in the background and never hold startup ([#4489](https://github.com/k2b-dev/cloud/issues/4489)) ([b6fa259](https://github.com/k2b-dev/cloud/commit/b6fa25903c0899acf3aab8cb0867b48d4de0e0a8))
* **cloud:** no icon stands as an empty box for a filled Tabler name ([#4560](https://github.com/k2b-dev/cloud/issues/4560)) ([e79bd17](https://github.com/k2b-dev/cloud/commit/e79bd1790c386970d9973923a0047774c471822f))
* **core:** an app's keys name all their creators in one statement ([#4539](https://github.com/k2b-dev/cloud/issues/4539)) ([e0f4baf](https://github.com/k2b-dev/cloud/commit/e0f4baf97b19dafa74851c96af16deb087932df7))
* **core:** the package typecheck covers Core's test folder, and its tests match what they test ([#4425](https://github.com/k2b-dev/cloud/issues/4425)) ([4627da2](https://github.com/k2b-dev/cloud/commit/4627da2532d0079191ec323051fd817d53402c77))
* **dashboard:** a tile that still loads stays calm in its reserved frame, with no spinner or loading words on screen ([#4502](https://github.com/k2b-dev/cloud/issues/4502)) ([3ac5eb2](https://github.com/k2b-dev/cloud/commit/3ac5eb2f26863da29d14fd0c0874a5d206e7f0c2))
* **dashboard:** widget states keep their message inside a medium tile in the order a page loads its stylesheets ([#4421](https://github.com/k2b-dev/cloud/issues/4421)) ([33d43cc](https://github.com/k2b-dev/cloud/commit/33d43ccff7397909ef5c35aa430bfca6a7884b0d))
* **docs:** the Kundenakte demo shows the rail of the Cloud shell as its mockup does ([#4120](https://github.com/k2b-dev/cloud/issues/4120)) ([08d7feb](https://github.com/k2b-dev/cloud/commit/08d7feb6162e68480a2d52f880409931fcb4302f))
* **grids:** select option colours accept only colours ([#4372](https://github.com/k2b-dev/cloud/issues/4372)) ([dfcb613](https://github.com/k2b-dev/cloud/commit/dfcb6135546a8a006e40daae9fac3ac36ef9b9c7))
* **mail:** a draft stuck on refused device input opens editable again and keeps the text as a recovery copy ([#4447](https://github.com/k2b-dev/cloud/issues/4447)) ([5a588e0](https://github.com/k2b-dev/cloud/commit/5a588e0c643457d19f87f32d1967582c1d15f3c0))
* **mail:** a failed v2 mailbox list says what failed in words ([#4552](https://github.com/k2b-dev/cloud/issues/4552)) ([0b17b51](https://github.com/k2b-dev/cloud/commit/0b17b51994112f16a1c3f32bc47232669a9102a1))
* **mail:** a rediscovery for a binding that is gone ends instead of dead-lettering ([#4133](https://github.com/k2b-dev/cloud/issues/4133)) ([59e5a0b](https://github.com/k2b-dev/cloud/commit/59e5a0bf7cb91346b67e6bfe743f8b88975d8a8e))
* **mail:** a restricted message's attachments and source are not handed out ([#4551](https://github.com/k2b-dev/cloud/issues/4551)) ([cd67098](https://github.com/k2b-dev/cloud/commit/cd67098e0121add478b2e93455fd7bc8727e3771))
* **mail:** an idle shared draft takes an update at the revision it shows, and refused writes name the current revision ([#4522](https://github.com/k2b-dev/cloud/issues/4522)) ([3e372a0](https://github.com/k2b-dev/cloud/commit/3e372a04147c8f9a663d66fb03863a415738d5e9))
* **mail:** cold view counts hold the first render only for a fixed wait ([#4483](https://github.com/k2b-dev/cloud/issues/4483)) ([efb0d34](https://github.com/k2b-dev/cloud/commit/efb0d34f9d9fb3c693ebce3426a5abbdbf8eabac))
* **mail:** draft session tests no longer depend on the diff clock under load ([#4399](https://github.com/k2b-dev/cloud/issues/4399)) ([2b2952d](https://github.com/k2b-dev/cloud/commit/2b2952d97d4f8c2d600d48fe9c10bbbc0fb40e8e))
* **notebooks:** a blank notebook's welcome page speaks the language of the person who creates it ([#4460](https://github.com/k2b-dev/cloud/issues/4460)) ([3c61e30](https://github.com/k2b-dev/cloud/commit/3c61e30fb9b6fc20f001f13d61f30bc8995112b7))
* **notebooks:** graph displays that show only their icon name themselves on hover ([#4319](https://github.com/k2b-dev/cloud/issues/4319)) ([94d76b1](https://github.com/k2b-dev/cloud/commit/94d76b1f528b373a645640c2d1f4e24d898019ae))
* **pulse:** a moment of another day names its day ([#4388](https://github.com/k2b-dev/cloud/issues/4388)) ([7ffc667](https://github.com/k2b-dev/cloud/commit/7ffc6672c506c69ee64d9d636a3964cf43e89e2b))
* **pulse:** the base list reads member counts and stores for all bases at once ([#4480](https://github.com/k2b-dev/cloud/issues/4480)) ([a0ca243](https://github.com/k2b-dev/cloud/commit/a0ca243c9ceafc6442fca2234d504597e887600d))
* **scripts:** any number of SQL meters open and close in one test process ([#4504](https://github.com/k2b-dev/cloud/issues/4504)) ([9ebb3c2](https://github.com/k2b-dev/cloud/commit/9ebb3c20613b40be43fdb158ceb07da4afaf80e1))
* **spaces/notebooks:** style strings take only stored colours ([#4367](https://github.com/k2b-dev/cloud/issues/4367)) ([4642704](https://github.com/k2b-dev/cloud/commit/464270478edfd1ba511e10086b0772284958b5bd))
* **spaces:** the overview reads only the Spaces a person reaches, on the space_id indexes ([#4509](https://github.com/k2b-dev/cloud/issues/4509)) ([6c100df](https://github.com/k2b-dev/cloud/commit/6c100dffd5ee50dba2eb5680c1e84927a2c2781f))
* **test:** a wait for a page's client names the scripts that did not load ([#4418](https://github.com/k2b-dev/cloud/issues/4418)) ([7952e9b](https://github.com/k2b-dev/cloud/commit/7952e9b685ce6595635c18686b4177ded8f06f7a))
* **test:** session origin posts wait for the page they navigate to before the next read ([#4469](https://github.com/k2b-dev/cloud/issues/4469)) ([7a7a454](https://github.com/k2b-dev/cloud/commit/7a7a4548f6f238bd68cce3c91225ab6f75283dd4))
* **test:** the shared test DOM provides matchMedia, so a v2 menu renders in behavior tests ([#4471](https://github.com/k2b-dev/cloud/issues/4471)) ([b633c2c](https://github.com/k2b-dev/cloud/commit/b633c2c343d7b9fee1b1e0e9ee9ed65a55d99863))
* **tools:** a tool page is one block from the top, with no white half beside a short result ([#4450](https://github.com/k2b-dev/cloud/issues/4450)) ([787d499](https://github.com/k2b-dev/cloud/commit/787d4996575811131ba93b8fef2d0af69351cfb4))
* **ui:** a bar never shows two '&', whatever the app's '&' is named or what menu follows it ([#4472](https://github.com/k2b-dev/cloud/issues/4472)) ([0995fa3](https://github.com/k2b-dev/cloud/commit/0995fa3be143e9ed63c291a0d205dad3c460fbd4))
* **ui:** a chart's first time label never draws over the lowest value label ([#4316](https://github.com/k2b-dev/cloud/issues/4316)) ([7632dcd](https://github.com/k2b-dev/cloud/commit/7632dcda9de732970f69a49f87e08133700b46dc))
* **ui:** a choice in a v2 menu always arrives, also when core holds no props for its group ([#4431](https://github.com/k2b-dev/cloud/issues/4431)) ([03e7e24](https://github.com/k2b-dev/cloud/commit/03e7e2469fa77dde1b9a4d794832376da6cbd452))
* **ui:** a choice in a v2 table row's menu no longer opens the row ([#4282](https://github.com/k2b-dev/cloud/issues/4282)) ([d131f37](https://github.com/k2b-dev/cloud/commit/d131f3780bacd7f068198306379cc4df627c860e))
* **ui:** a filter editor keeps a field's focus while it is typed in ([#4155](https://github.com/k2b-dev/cloud/issues/4155)) ([787ba31](https://github.com/k2b-dev/cloud/commit/787ba3176a5a54f6b55fa646eb0bf60154dccdaa))
* **ui:** a focused v2 tab that hides for lack of room hands its focus to the menu tab ([#4508](https://github.com/k2b-dev/cloud/issues/4508)) ([5a68bc5](https://github.com/k2b-dev/cloud/commit/5a68bc59b38c065d3584fe0d54e728f28a1042d6))
* **ui:** a jump to a place far down scrolls only the v2 pane, never the frame around it ([#4496](https://github.com/k2b-dev/cloud/issues/4496)) ([63a056c](https://github.com/k2b-dev/cloud/commit/63a056c315a79c98ae67e448e60dba65692f0f59))
* **ui:** a record's head on the phone keeps avatar, name and actions in one row ([#4465](https://github.com/k2b-dev/cloud/issues/4465)) ([c19e19a](https://github.com/k2b-dev/cloud/commit/c19e19a7d64b17052d703f37450fa6540efb969d))
* **ui:** a small island inside a v2 container keeps the container's layout ([#4193](https://github.com/k2b-dev/cloud/issues/4193)) ([14ed3ec](https://github.com/k2b-dev/cloud/commit/14ed3ecc310c45100e402279bd8a87843197b642))
* **ui:** a split inside a v2 column counts for the room of its workspace, and side belongs on the inner column ([#4434](https://github.com/k2b-dev/cloud/issues/4434)) ([6d2f5e3](https://github.com/k2b-dev/cloud/commit/6d2f5e30885e8aa5ec61ec7cd7087d4a8a88a181))
* **ui:** a state timeline draws each state in its own colour and keeps lane names and legend in the chart ([#4233](https://github.com/k2b-dev/cloud/issues/4233)) ([8fbc654](https://github.com/k2b-dev/cloud/commit/8fbc6544a685e5a488347038caf187e0507b6439))
* **ui:** a status row's selection bar folds the actions without room into a "&" menu and never cuts its count ([#4330](https://github.com/k2b-dev/cloud/issues/4330)) ([8129491](https://github.com/k2b-dev/cloud/commit/8129491ef5efcbe5f8d601baf14484863f50e3db))
* **ui:** a table in v2 reading text keeps its cells apart and reads like a small table ([#4381](https://github.com/k2b-dev/cloud/issues/4381)) ([878e2e4](https://github.com/k2b-dev/cloud/commit/878e2e4899739ed6426b8a22d403c23d5902467e))
* **ui:** a test's cleanup waits for the library's own loads ([#4499](https://github.com/k2b-dev/cloud/issues/4499)) ([06c1eb8](https://github.com/k2b-dev/cloud/commit/06c1eb85434aa32ed0f8f8f304b8ae61b1efd6e6))
* **ui:** a v2 bar's fold comes to rest when a part at its end has an auto margin ([#4575](https://github.com/k2b-dev/cloud/issues/4575)) ([70a462e](https://github.com/k2b-dev/cloud/commit/70a462e309fac62ee708358eb31f770536393595))
* **ui:** a v2 button with words and a label is named by its label ([#4384](https://github.com/k2b-dev/cloud/issues/4384)) ([bc4f048](https://github.com/k2b-dev/cloud/commit/bc4f048795a7a96d49aca67951ff237533ac1a29))
* **ui:** a v2 detail named far longer than its bar keeps a few letters of its way back ([#4416](https://github.com/k2b-dev/cloud/issues/4416)) ([b8f2970](https://github.com/k2b-dev/cloud/commit/b8f29700a0acb5f8831360d14c9b323a73521c89))
* **ui:** a v2 dialog that opens without a key gives its first focus without a ring ([#4128](https://github.com/k2b-dev/cloud/issues/4128)) ([07177f0](https://github.com/k2b-dev/cloud/commit/07177f07e7991a43be70d2836c855420116073b0))
* **ui:** a v2 hydration wait that fails names Playwright's reason ([#4129](https://github.com/k2b-dev/cloud/issues/4129)) ([ece75b0](https://github.com/k2b-dev/cloud/commit/ece75b02e317698caced565ad0112afd3e91b6c6))
* **ui:** a v2 nav list shows no scroll bar of its own, so its rows reach the sidebar's edge in WebKit ([#4507](https://github.com/k2b-dev/cloud/issues/4507)) ([6541e11](https://github.com/k2b-dev/cloud/commit/6541e11b8b7a626f6944e9cf317141f93e31a6a3))
* **ui:** a v2 nav without a tree and a menu without a panel load none of their code ([#4449](https://github.com/k2b-dev/cloud/issues/4449)) ([89e179c](https://github.com/k2b-dev/cloud/commit/89e179c886739502b065adbcdc954fee1faca9b9))
* **ui:** a v2 path keeps the page it names whole and folds its middle places into a menu ([#4395](https://github.com/k2b-dev/cloud/issues/4395)) ([856c65c](https://github.com/k2b-dev/cloud/commit/856c65cbfc9ac992191cf3d5f44ac25819f00e59))
* **ui:** a v2 section's way to all of it stands under its rows on their text edge ([#4337](https://github.com/k2b-dev/cloud/issues/4337)) ([b56a722](https://github.com/k2b-dev/cloud/commit/b56a722d96b0d8b576804acc67dfdc2acdcd568c))
* **ui:** a v2 sheet on the phone stays on the bottom when its content resizes or a script scrolls in it ([#4168](https://github.com/k2b-dev/cloud/issues/4168)) ([ca69f1f](https://github.com/k2b-dev/cloud/commit/ca69f1f6566b8d4bbbc23430c789c5678394d2f0))
* **ui:** a v2 sheet stands in place at once when the person asks for less motion ([#4459](https://github.com/k2b-dev/cloud/issues/4459)) ([bcdd2d1](https://github.com/k2b-dev/cloud/commit/bcdd2d194e643afcd84eeeda37f0cd9f38c9d3f0))
* **ui:** a v2 status row keeps its end on the phone, folding what has no room into +n ([#4426](https://github.com/k2b-dev/cloud/issues/4426)) ([ebd617e](https://github.com/k2b-dev/cloud/commit/ebd617eaf4e7c9b09268391516a7b4435a67edf9))
* **ui:** a v2 text of several lines no longer measures itself after it has left the page ([#4520](https://github.com/k2b-dev/cloud/issues/4520)) ([bf70bd3](https://github.com/k2b-dev/cloud/commit/bf70bd3204663465445c046b25559052c807b895))
* **ui:** calendar all-day titles and hour labels are never cut at the view's sticky edges ([#4375](https://github.com/k2b-dev/cloud/issues/4375)) ([f54774e](https://github.com/k2b-dev/cloud/commit/f54774e9f7b3eb15f50837b940bcf0faeaf64b28))
* **ui:** charts in a v2 screen use the v2 tokens ([#4140](https://github.com/k2b-dev/cloud/issues/4140)) ([e2b4f89](https://github.com/k2b-dev/cloud/commit/e2b4f89891bcdc69356999612aba7808f335dc6a))
* **ui:** charts size and style themselves in a v2-only page and load in their own shape ([#4158](https://github.com/k2b-dev/cloud/issues/4158)) ([4d9c79a](https://github.com/k2b-dev/cloud/commit/4d9c79ad845c5fa40d055c5d62a13019c9a81dc0))
* **ui:** crowded calendar bands keep whole lines and collapse into +n ([#4265](https://github.com/k2b-dev/cloud/issues/4265)) ([7145fb5](https://github.com/k2b-dev/cloud/commit/7145fb53e562884a6043388701ac515f64919968))
* **ui:** many places in a v2 sidebar scroll between its head and its foot ([#4516](https://github.com/k2b-dev/cloud/issues/4516)) ([d6b42ef](https://github.com/k2b-dev/cloud/commit/d6b42ef6d71bb63da1716407e377323f5055af3c))
* **ui:** on the phone the floating main action leaves room under the last row ([#4454](https://github.com/k2b-dev/cloud/issues/4454)) ([3fc8335](https://github.com/k2b-dev/cloud/commit/3fc8335a5a21abd6265092e07376a14cf2994948))
* **ui:** screens no longer open hints about where something moved ([#4500](https://github.com/k2b-dev/cloud/issues/4500)) ([f4a70ab](https://github.com/k2b-dev/cloud/commit/f4a70abb61a07d6aec7b192dd13deb504ca86199))
* **ui:** settled() waits for real frames under Playwright's clock ([#4429](https://github.com/k2b-dev/cloud/issues/4429)) ([951cfc5](https://github.com/k2b-dev/cloud/commit/951cfc5f93d4fe298b97bb9ada5d9afa8278c545))
* **ui:** status row parts, segments and section actions give way without losing words or names ([#4221](https://github.com/k2b-dev/cloud/issues/4221)) ([70eb6d7](https://github.com/k2b-dev/cloud/commit/70eb6d748a48ebe89b603d6047deb5a43c776a8e))
* **ui:** the island error fallback loads only its own modules, not the button, marks and states of every app ([#4333](https://github.com/k2b-dev/cloud/issues/4333)) ([35ee1f6](https://github.com/k2b-dev/cloud/commit/35ee1f6e3ded87a8590a9348c77dbebd584527ce))
* **ui:** the island-transparent v2.css no longer makes WebKit restyle on every change ([#4329](https://github.com/k2b-dev/cloud/issues/4329)) ([cd18a32](https://github.com/k2b-dev/cloud/commit/cd18a32289f4e370f5e0caf962b8eb4afb552567))
* **ui:** the swatch of a v2 colour field says which colour it holds ([#4318](https://github.com/k2b-dev/cloud/issues/4318)) ([c2a5ef7](https://github.com/k2b-dev/cloud/commit/c2a5ef7a3399a05775dbde9405dad6ce2fae826b))
* **ui:** the v2 outline counts one primary action per page and per open dialog ([#4117](https://github.com/k2b-dev/cloud/issues/4117)) ([3a53bdc](https://github.com/k2b-dev/cloud/commit/3a53bdcfa48a5c50da1bc6efa57d0895d2f38b23))
* **ui:** the v2 select typeahead test waits for the highlight before it presses Enter ([#4127](https://github.com/k2b-dev/cloud/issues/4127)) ([abc463b](https://github.com/k2b-dev/cloud/commit/abc463b456d42a8e00828a57d7aed5f61a3282e8))
* **ui:** v1 colour props take only colours ([#4363](https://github.com/k2b-dev/cloud/issues/4363)) ([25762ef](https://github.com/k2b-dev/cloud/commit/25762efef15eeb4599561e0d2758b3cf6468be65))
* **ui:** v2 colour props take only colours ([#4359](https://github.com/k2b-dev/cloud/issues/4359)) ([5e93d02](https://github.com/k2b-dev/cloud/commit/5e93d021d92d818afc58d47e1e2d9fcde499509f))
* **ui:** v2 grips show only on hover, focus and drag, and hold their line beside an overflowing table ([#4291](https://github.com/k2b-dev/cloud/issues/4291)) ([b575719](https://github.com/k2b-dev/cloud/commit/b575719ad37e0115561565d66fa8a693a73decf0))
* **ui:** v2 grips stay in sight, a record's head keeps clear of its actions, and a narrow digest stacks ([#4119](https://github.com/k2b-dev/cloud/issues/4119)) ([1d66541](https://github.com/k2b-dev/cloud/commit/1d66541db2a6cd672b5eb1b50bf026802fbe75c1))
* **ui:** v2 list addresses keep their commas readable ([#4138](https://github.com/k2b-dev/cloud/issues/4138)) ([018753f](https://github.com/k2b-dev/cloud/commit/018753ff12ab1d973334245671b179ae85bf944b))
* **ui:** v2 pane and column grips resize by pointer and keyboard ([#4217](https://github.com/k2b-dev/cloud/issues/4217)) ([d4f6cee](https://github.com/k2b-dev/cloud/commit/d4f6ceee6f1d70000d832c8cdacb9b5216d6d9c4))
* **ui:** v2 section titles wrap, checks carry a description, and multi-line fields grow with their words ([#4216](https://github.com/k2b-dev/cloud/issues/4216)) ([8fc7645](https://github.com/k2b-dev/cloud/commit/8fc7645287cdc4298eea0da3a4904ac049a027f0))
* **ui:** v2 splits, multi-line fields, phone sheets and status rows hold their shape ([#4161](https://github.com/k2b-dev/cloud/issues/4161)) ([d64273b](https://github.com/k2b-dev/cloud/commit/d64273b189fa3b06048f012b26ceeaacf3548e8a))
* **ui:** v2 text fields send autocomplete and keyboard hints in the server's markup ([#4184](https://github.com/k2b-dev/cloud/issues/4184)) ([938dc1a](https://github.com/k2b-dev/cloud/commit/938dc1ad9ba58cddf6fda7a8cc2a5a56ce72ff64))
* **ui:** v2 Ticks fit their cell and keep their newest slots in view ([#4428](https://github.com/k2b-dev/cloud/issues/4428)) ([3726dc6](https://github.com/k2b-dev/cloud/commit/3726dc695f946085abf15414990b6e61dbc45b56))
* **venue:** a venue page refuses more sections and menu items than its page budget holds ([#4557](https://github.com/k2b-dev/cloud/issues/4557)) ([45e988b](https://github.com/k2b-dev/cloud/commit/45e988b5abd61f7f2ec83b0ac4525e77eaa5fa28))
* **weather:** one person saves at most 100 places, and a place page asks their forecasts a few at a time ([#4550](https://github.com/k2b-dev/cloud/issues/4550)) ([36f7abb](https://github.com/k2b-dev/cloud/commit/36f7abb84fe93c09bb1fcc36de7b6bd8a23c543c))


### Performance Improvements

* **cloud:** a long v2 navigation weighs on a page by its first 40 entries, and on an island only once its menu opens ([#4387](https://github.com/k2b-dev/cloud/issues/4387)) ([31f50f1](https://github.com/k2b-dev/cloud/commit/31f50f167cf838047fc91d5badc0cdf2b50e9ee0))
* **cloud:** an island takes only what it uses from @k2b/cloud, also through the islands barrel ([#4441](https://github.com/k2b-dev/cloud/issues/4441)) ([1e3788d](https://github.com/k2b-dev/cloud/commit/1e3788d30480d94ab67be430f5ced72d3f61f643))
* **core:** logs by source and recent workflow runs read through indexes of their own ([#4481](https://github.com/k2b-dev/cloud/issues/4481)) ([f2eaf02](https://github.com/k2b-dev/cloud/commit/f2eaf02ecd65514752ad84622fbee2cecbdaed77))
* **grids:** a base's catalog reads its seven kinds in one statement ([#4525](https://github.com/k2b-dev/cloud/issues/4525)) ([ae21ed7](https://github.com/k2b-dev/cloud/commit/ae21ed737095f7cc5a0198c04b31777ed8b81699))
* **ui:** the shipped v2.css gives an inner part of a primitive no way through an island wrapper ([#4357](https://github.com/k2b-dev/cloud/issues/4357)) ([fbfc73b](https://github.com/k2b-dev/cloud/commit/fbfc73bc03c68734d848ea1c8f3a6eb3ef27bf43))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @k2b/stdlib bumped to 0.37.0
</details>

<details><summary>npm-editor: 0.16.0</summary>

## [0.16.0](https://github.com/k2b-dev/cloud/compare/npm-editor-v0.15.1...npm-editor-v0.16.0) (2026-11-28)


###   BREAKING CHANGES

* **stdlib:** @k2b/stdlib no longer exports `charts`, `scatter`, `line`, `bar`, `pie`, `donut`, `sparkline`, `histogram`, `boxplot`, `gauge`, `barGauge`, `stat`, `heatmap`, `map`, `stateTimeline`, `chartDatumSvg`, `svgRoot`, `escapeXml`, `normalizePadding`, `computeDomain`, `niceStep`, `extendDomainToNice`, `mapRange`, `mapLog`, `niceLogTicks`, `linearRegression`, `computeBoxStats`, `autoBin`, `linePathD`, `smoothPathD`, `arcPathD`, `markerPath`, `stepPathD` or the types `Point`, `Series`, `MarkerShape`, `LineStyle`, `MapPoint`, `MapSeries`, `MapViewport`, `MapOptions`, `BarItem`, `SliceItem`, `AxisOptions`, `Padding`, `ChartDatum`, `ChartOptions`, `ReferenceLine`. Replacement: render with `Chart` from `@k2b/ui/charts`, or import the same names from `@k2b/ui/charts/core`, which keeps their signatures and markup.

### Features

* **mail:** Mail's list and reader are built on @k2b/ui v2 behind a pilot setting ([#4104](https://github.com/k2b-dev/cloud/issues/4104)) ([d4cddb9](https://github.com/k2b-dev/cloud/commit/d4cddb914fa7452e0cd69737dacc2fdab01057d1))
* **stdlib:** charts live only in @k2b/ui/charts ([#4143](https://github.com/k2b-dev/cloud/issues/4143)) ([276ef71](https://github.com/k2b-dev/cloud/commit/276ef71df312eaba3f71707914aeb8dd4eb995c8))
* **ui:** the Markdown editors' toolbars follow v2 inside a v2 screen ([#4243](https://github.com/k2b-dev/cloud/issues/4243)) ([1c7cdec](https://github.com/k2b-dev/cloud/commit/1c7cdec5fe997738fabc8a30c7abd32a5c96f187))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/stdlib bumped from 0.36.1 to 0.37.0
    * @k2b/ui bumped from 0.66.0 to 0.67.0
</details>

<details><summary>npm-ssr: 0.24.0</summary>

## [0.24.0](https://github.com/k2b-dev/cloud/compare/npm-ssr-v0.23.2...npm-ssr-v0.24.0) (2026-11-28)


###   BREAKING CHANGES

* **faq:** Before upgrading, export entries with the old running application using cld --profile ADMIN_PROFILE faq list --json > faq-export.json. Core permanently drops the faq schema and its entries. A restarted old FAQ container recreates an empty schema, so remove its automatic restart/deployment configuration first. After upgrade, recovery requires a pre-upgrade export/backup. Copy content into Notebook notes if needed; review sharing/languages. Help does not import entries automatically. Remove the cached faq CLI plugin after exporting and update old URLs/integrations. Stop/remove app-faq with the previous deployment configuration, remove its workload/service/key mount, and wait at least three minutes before upgrading Core. Core deletes remembered registry/package records, app keys and service accounts with their grants, application access, settings/domains, rail and chooser/consent preferences, notifications and deliveries, approvals and remembered approval grants, Help/search documents and Skill catalogs, app-owned Code, workflow runs/scopes and AI admission/budget state, event subscriptions/outbox data, and the app's own provider execution/idempotency records. Explicit retired-app grants in non-revoked mandates are pruned and affected active mandates are paused and audited. Historical audit events, AI inference/quota and structured-run records, outgoing-mail messages, logging and other providers' capability executions remain, including executions called through the removed app. An app.removed audit is written only when rows are removed or changed, with separate deletion/change counts; fresh installations get no event. Revoked mandates owned by other apps stay unchanged. Dependent cascades are additional. Other apps' data stays. Cleanup can extend Core startup on large installations; wait for Core readiness.

### Features

* **faq:** the FAQ app is removed ([#4178](https://github.com/k2b-dev/cloud/issues/4178)) ([4964b1f](https://github.com/k2b-dev/cloud/commit/4964b1f40b8cd69648e15fe4967d98e3cd45abc9))
* **ssr:** island props travel in a comment instead of an escaped attribute ([#4510](https://github.com/k2b-dev/cloud/issues/4510)) ([8b24085](https://github.com/k2b-dev/cloud/commit/8b240854cfb5ab2d21175f753cb23768111dcba0))
</details>

<details><summary>npm-stdlib: 0.37.0</summary>

## [0.37.0](https://github.com/k2b-dev/cloud/compare/npm-stdlib-v0.36.1...npm-stdlib-v0.37.0) (2026-11-28)


###   BREAKING CHANGES

* **stdlib:** @k2b/stdlib no longer exports `charts`, `scatter`, `line`, `bar`, `pie`, `donut`, `sparkline`, `histogram`, `boxplot`, `gauge`, `barGauge`, `stat`, `heatmap`, `map`, `stateTimeline`, `chartDatumSvg`, `svgRoot`, `escapeXml`, `normalizePadding`, `computeDomain`, `niceStep`, `extendDomainToNice`, `mapRange`, `mapLog`, `niceLogTicks`, `linearRegression`, `computeBoxStats`, `autoBin`, `linePathD`, `smoothPathD`, `arcPathD`, `markerPath`, `stepPathD` or the types `Point`, `Series`, `MarkerShape`, `LineStyle`, `MapPoint`, `MapSeries`, `MapViewport`, `MapOptions`, `BarItem`, `SliceItem`, `AxisOptions`, `Padding`, `ChartDatum`, `ChartOptions`, `ReferenceLine`. Replacement: render with `Chart` from `@k2b/ui/charts`, or import the same names from `@k2b/ui/charts/core`, which keeps their signatures and markup.

### Features

* **stdlib:** charts live only in @k2b/ui/charts ([#4143](https://github.com/k2b-dev/cloud/issues/4143)) ([276ef71](https://github.com/k2b-dev/cloud/commit/276ef71df312eaba3f71707914aeb8dd4eb995c8))
</details>

<details><summary>npm-ui: 0.67.0</summary>

## [0.67.0](https://github.com/k2b-dev/cloud/compare/npm-ui-v0.66.0...npm-ui-v0.67.0) (2026-11-28)


###   BREAKING CHANGES

* **stdlib:** @k2b/stdlib no longer exports `charts`, `scatter`, `line`, `bar`, `pie`, `donut`, `sparkline`, `histogram`, `boxplot`, `gauge`, `barGauge`, `stat`, `heatmap`, `map`, `stateTimeline`, `chartDatumSvg`, `svgRoot`, `escapeXml`, `normalizePadding`, `computeDomain`, `niceStep`, `extendDomainToNice`, `mapRange`, `mapLog`, `niceLogTicks`, `linearRegression`, `computeBoxStats`, `autoBin`, `linePathD`, `smoothPathD`, `arcPathD`, `markerPath`, `stepPathD` or the types `Point`, `Series`, `MarkerShape`, `LineStyle`, `MapPoint`, `MapSeries`, `MapViewport`, `MapOptions`, `BarItem`, `SliceItem`, `AxisOptions`, `Padding`, `ChartDatum`, `ChartOptions`, `ReferenceLine`. Replacement: render with `Chart` from `@k2b/ui/charts`, or import the same names from `@k2b/ui/charts/core`, which keeps their signatures and markup.

### Features

* **accounts:** an agent's page shows its API keys and creates and revokes them on v2 ([#4110](https://github.com/k2b-dev/cloud/issues/4110)) ([a1d7969](https://github.com/k2b-dev/cloud/commit/a1d79695ec9bb604d607f48766f6fcae9a22807e))
* **chat:** v2 chats stand in the nav, and a place's discussions are cards in its stream that open in its place ([#4531](https://github.com/k2b-dev/cloud/issues/4531)) ([4d68a6f](https://github.com/k2b-dev/cloud/commit/4d68a6f8907c4cf13ecc1f88fbb2168ef4d1e52d))
* **cloud:** a v2 principal picker, and the v2 permission editor adds with it ([#4415](https://github.com/k2b-dev/cloud/issues/4415)) ([98a7649](https://github.com/k2b-dev/cloud/commit/98a7649b24a742400370f79f40f30c2b1c9314f5))
* **cloud:** islands load one module of @k2b/cloud/shared and no v1 code for their error fallback ([#4242](https://github.com/k2b-dev/cloud/issues/4242)) ([03700a1](https://github.com/k2b-dev/cloud/commit/03700a1b938de5edd6f6d7eeaa8bac7f417f9f38))
* **cloud:** on the phone a v2 page's search sits in the shell's phone bar ([#4162](https://github.com/k2b-dev/cloud/issues/4162)) ([73e08c0](https://github.com/k2b-dev/cloud/commit/73e08c096c54650e7a3a7edea5326f3444233c06))
* **cloud:** the access dialog opens on UI v2 from v2 pages ([#4207](https://github.com/k2b-dev/cloud/issues/4207)) ([f7bcbd2](https://github.com/k2b-dev/cloud/commit/f7bcbd2208afe53eddc576e5a0d1c56ac52d26c9))
* **cloud:** visitor pages render on UI v2 with MinimalLayout ui v2 ([#4227](https://github.com/k2b-dev/cloud/issues/4227)) ([29e506b](https://github.com/k2b-dev/cloud/commit/29e506b27a83177e0f30642485325920e6e4482c))
* **core:** account pages and pairing run on UI v2 with one account and one activity ([#4173](https://github.com/k2b-dev/cloud/issues/4173)) ([2754b0f](https://github.com/k2b-dev/cloud/commit/2754b0fc702f6595639c6db3fedd1ed1fb0ffc0c))
* **core:** AI and Code administration run on UI v2 ([#4396](https://github.com/k2b-dev/cloud/issues/4396)) ([af8b9d9](https://github.com/k2b-dev/cloud/commit/af8b9d948932d89a0e31eda877326b1a688c0882))
* **docs:** Fibel shows UI v2 as topic pages with live examples, code and generated props ([#4142](https://github.com/k2b-dev/cloud/issues/4142)) ([a6e0af3](https://github.com/k2b-dev/cloud/commit/a6e0af375dfa523bc2304729da9af6793241540c))
* **gateway-ops:** a log entry shows only its request in one step ([#4180](https://github.com/k2b-dev/cloud/issues/4180)) ([7ebf051](https://github.com/k2b-dev/cloud/commit/7ebf05158f7bb670123572d75ca870f2ef1d588b))
* **mail:** later and remind me offer times in a submenu and pick any date from a calendar ([#4157](https://github.com/k2b-dev/cloud/issues/4157)) ([84c3397](https://github.com/k2b-dev/cloud/commit/84c3397484c1ebaf3cefeb86a7fb6ff6f2134c91))
* **mail:** the later calendar takes the place of the times and starts at an offered time ([#4249](https://github.com/k2b-dev/cloud/issues/4249)) ([ec5c3a5](https://github.com/k2b-dev/cloud/commit/ec5c3a5a0b16670ad6b8e1cb4f21969e22958618))
* **notebooks:** a note's backlinks come one page at a time with their total ([#4422](https://github.com/k2b-dev/cloud/issues/4422)) ([0475e18](https://github.com/k2b-dev/cloud/commit/0475e1816dc7fe08c0f64180ce4a96e0941be576))
* **ssr:** island props travel in a comment instead of an escaped attribute ([#4510](https://github.com/k2b-dev/cloud/issues/4510)) ([8b24085](https://github.com/k2b-dev/cloud/commit/8b240854cfb5ab2d21175f753cb23768111dcba0))
* **stdlib:** charts live only in @k2b/ui/charts ([#4143](https://github.com/k2b-dev/cloud/issues/4143)) ([276ef71](https://github.com/k2b-dev/cloud/commit/276ef71df312eaba3f71707914aeb8dd4eb995c8))
* **ui:** a calendar in a v2 Canvas lies flat instead of drawing a card ([#4365](https://github.com/k2b-dev/cloud/issues/4365)) ([32eb7c5](https://github.com/k2b-dev/cloud/commit/32eb7c52bdba40685e1724363f0b9932a03ac8cb))
* **ui:** a compact Prose shows short text a person wrote as text, without tables or large headings ([#4382](https://github.com/k2b-dev/cloud/issues/4382)) ([38b466c](https://github.com/k2b-dev/cloud/commit/38b466c8d0893e192688b24ca9e6a8867efc8415))
* **ui:** a context column stands beside its main column only where there is room, and a detail grows to two columns on a large screen ([#4340](https://github.com/k2b-dev/cloud/issues/4340)) ([ae50d4f](https://github.com/k2b-dev/cloud/commit/ae50d4f4396cdb6ae26357b296abb5c2ea3b1bdc))
* **ui:** a heat calendar shows a year of days in tones of one colour ([#4445](https://github.com/k2b-dev/cloud/issues/4445)) ([1fba4de](https://github.com/k2b-dev/cloud/commit/1fba4decd89772f1157c0c2c2b4526db0f14e3a6))
* **ui:** a line chart takes quiet bands, a colour scale for its line, and a track of bars under it ([#4461](https://github.com/k2b-dev/cloud/issues/4461)) ([0ffa797](https://github.com/k2b-dev/cloud/commit/0ffa797afdffc8080d10ab2e203761ba0fe12f4e))
* **ui:** a long title in a detail's head takes two lines, with its full words as a tooltip ([#4257](https://github.com/k2b-dev/cloud/issues/4257)) ([e110b6b](https://github.com/k2b-dev/cloud/commit/e110b6bcf9a07cf3f55482c1e23afde84416134f))
* **ui:** a pane's head and its toolbar are one block, a head's search is its symbol, and a row keeps its time beside its deed ([#4537](https://github.com/k2b-dev/cloud/issues/4537)) ([0525fcd](https://github.com/k2b-dev/cloud/commit/0525fcd4b2178fe041b780e77f16f42f74239655))
* **ui:** a state timeline marks now, keeps runs of seconds visible, and draws planned runs as outlines ([#4344](https://github.com/k2b-dev/cloud/issues/4344)) ([68bb47a](https://github.com/k2b-dev/cloud/commit/68bb47a5199c1cd9f9bb2a8525a31b47f9d0c986))
* **ui:** a status row lead gives way first and keeps its words as hint, its statement carries tinted chips, and measureV2Layout finds text under its neighbour ([#4259](https://github.com/k2b-dev/cloud/issues/4259)) ([dd5ac30](https://github.com/k2b-dev/cloud/commit/dd5ac30cdf70a71ec84106e6e04c9d59d26b1b02))
* **ui:** a v2 bar folds the end's buttons that do not fit into a menu, and its start gives way down to its least ([#4392](https://github.com/k2b-dev/cloud/issues/4392)) ([af69ef8](https://github.com/k2b-dev/cloud/commit/af69ef8f8f30bbfbc0ab8e3ac2bef11cf4615045))
* **ui:** a v2 button can be a toggle that is pressed, such as a favourite star ([#4122](https://github.com/k2b-dev/cloud/issues/4122)) ([6209b4a](https://github.com/k2b-dev/cloud/commit/6209b4a9ede5b36057999d7115efbe22e31b1f84))
* **ui:** a v2 Canvas can be the whole pane, its drawing scrolls inside and what stands under it stays in sight ([#4356](https://github.com/k2b-dev/cloud/issues/4356)) ([b42f1cb](https://github.com/k2b-dev/cloud/commit/b42f1cb52c1a11af14abd720fe8ead241bf617aa))
* **ui:** a v2 date picker for a moment ahead shows six weeks from this week ([#4252](https://github.com/k2b-dev/cloud/issues/4252)) ([0973625](https://github.com/k2b-dev/cloud/commit/0973625044b9c83755588b2692dfe3535c20b211))
* **ui:** a v2 empty state can show that something went wrong or waits ([#4323](https://github.com/k2b-dev/cloud/issues/4323)) ([4a22492](https://github.com/k2b-dev/cloud/commit/4a2249203ea6f1b8c91911827d3c1513ee9a592e))
* **ui:** a v2 head search sends its text to the server without JavaScript ([#4279](https://github.com/k2b-dev/cloud/issues/4279)) ([3edff0f](https://github.com/k2b-dev/cloud/commit/3edff0f809ac352eb4d1030c12f3eb154c19d6a8))
* **ui:** a v2 link button can download, and addressOf is public ([#4412](https://github.com/k2b-dev/cloud/issues/4412)) ([3e73e47](https://github.com/k2b-dev/cloud/commit/3e73e4770c76a45e81b8d2b34990607381f41a0c))
* **ui:** a v2 menu entry can carry a data colour as a dot before its words ([#4457](https://github.com/k2b-dev/cloud/issues/4457)) ([9d05e36](https://github.com/k2b-dev/cloud/commit/9d05e3622b33c194af32a1c8ddc183d9d0d89cdb))
* **ui:** a v2 nav holds a search, a main action and an app's own list, which is the phone's page ([#4443](https://github.com/k2b-dev/cloud/issues/4443)) ([d9714e7](https://github.com/k2b-dev/cloud/commit/d9714e7dcd9cddaef0434766f3bb448a95d322b2))
* **ui:** a v2 notice can name its one thing to do as its primary deed ([#4298](https://github.com/k2b-dev/cloud/issues/4298)) ([e871206](https://github.com/k2b-dev/cloud/commit/e87120649d9d6e768f73044f5be3515b4c87a14a))
* **ui:** a v2 page can take its accent from data, with readable ink ([#4567](https://github.com/k2b-dev/cloud/issues/4567)) ([e7123d5](https://github.com/k2b-dev/cloud/commit/e7123d586a704025ea97149a2433ad3e0c98bf5f))
* **ui:** a v2 pane without a head names itself after its way back on the phone ([#4296](https://github.com/k2b-dev/cloud/issues/4296)) ([ea831a3](https://github.com/k2b-dev/cloud/commit/ea831a3ff707b3a41bfe620f3be68159316a2ae7))
* **ui:** a v2 RangeBar shows a range on a shared scale, and a v2 icon takes a data colour ([#4442](https://github.com/k2b-dev/cloud/issues/4442)) ([f34ea3d](https://github.com/k2b-dev/cloud/commit/f34ea3dcfef792aea291ae35f7bbc644cfd58589))
* **ui:** a v2 row stands at a level in a flat list ([#4427](https://github.com/k2b-dev/cloud/issues/4427)) ([d759624](https://github.com/k2b-dev/cloud/commit/d7596240e4e9281b2b4a7bc001e936509480e0b6))
* **ui:** a v2 row's deed is named by its words and then the row's title ([#4307](https://github.com/k2b-dev/cloud/issues/4307)) ([4876812](https://github.com/k2b-dev/cloud/commit/4876812fb1483e50ee68b5d5d672eaf989603ee4))
* **ui:** a v2 section can keep its content to the reading measure ([#4320](https://github.com/k2b-dev/cloud/issues/4320)) ([2525750](https://github.com/k2b-dev/cloud/commit/252575060e264db759bbebee7ec4d08d1daec517))
* **ui:** a v2 sidebar entry shows work that runs in the place of its dot ([#4281](https://github.com/k2b-dev/cloud/issues/4281)) ([e8967cd](https://github.com/k2b-dev/cloud/commit/e8967cd31e00e19dcbfcfe19ef8f399c3763e34d))
* **ui:** a v2 state can be quiet, its dot and word without the tinted round ([#4326](https://github.com/k2b-dev/cloud/issues/4326)) ([2e06496](https://github.com/k2b-dev/cloud/commit/2e064964a44a4ba4c0a9bf2956bdfc7a17899232))
* **ui:** a v2 status row drops its figures when narrow and reserves a loading mark; phone rows end in a status ([#4139](https://github.com/k2b-dev/cloud/issues/4139)) ([fa6f5b7](https://github.com/k2b-dev/cloud/commit/fa6f5b7949e95fbfa82f52b752b8dacca300ac38))
* **ui:** after a touch on a v2 table head its column grips take a 44 px target, and a focus in the head shows them ([#4435](https://github.com/k2b-dev/cloud/issues/4435)) ([1ed5465](https://github.com/k2b-dev/cloud/commit/1ed5465021cbd2ab9c6940852d6a402cfac66aac))
* **ui:** people's faces spread over eleven hues that stay readable and apart, also for colour-blind people ([#4530](https://github.com/k2b-dev/cloud/issues/4530)) ([6a644ae](https://github.com/k2b-dev/cloud/commit/6a644ae24f39c75110c11526d7e71cf34cde9532))
* **ui:** the Markdown editors' toolbars follow v2 inside a v2 screen ([#4243](https://github.com/k2b-dev/cloud/issues/4243)) ([1c7cdec](https://github.com/k2b-dev/cloud/commit/1c7cdec5fe997738fabc8a30c7abd32a5c96f187))
* **ui:** the v2 date picker takes its time from the ui-sdk time input ([#4224](https://github.com/k2b-dev/cloud/issues/4224)) ([06c28c6](https://github.com/k2b-dev/cloud/commit/06c28c6aee3115036e5f0b81b4ccf5c30e2071d1))
* **ui:** the v2 dialog, a sheet on the phone, Dialog.confirm, and a Select that is a form field ([#4106](https://github.com/k2b-dev/cloud/issues/4106)) ([30f04ae](https://github.com/k2b-dev/cloud/commit/30f04ae642785212a7b4265011595c9cd8f0ec9f))
* **ui:** the v2 primary action takes its app's main colour, plum for the assistant ([#4297](https://github.com/k2b-dev/cloud/issues/4297)) ([d341768](https://github.com/k2b-dev/cloud/commit/d341768a7b6068bba751633f9b542a15de19e3ac))
* **ui:** the v2 sidebar becomes a drawer where it no longer fits beside the columns ([#4123](https://github.com/k2b-dev/cloud/issues/4123)) ([d843aab](https://github.com/k2b-dev/cloud/commit/d843aabebcab674cfd5baed650def188b0df4c2b))
* **ui:** Ticks show one state per time slot, ok soft in the app colour and a failure red ([#4353](https://github.com/k2b-dev/cloud/issues/4353)) ([4f6229f](https://github.com/k2b-dev/cloud/commit/4f6229f00c0707f7e9e5c3a17fb91c4c1b01b8f3))
* **ui:** v2 a first start stands in the middle of the page, with tiles that share a row ([#4477](https://github.com/k2b-dev/cloud/issues/4477)) ([64b0c8a](https://github.com/k2b-dev/cloud/commit/64b0c8ac42f1ac5c31a807603a3aea9f43692d8c))
* **ui:** v2 a start card previews what it makes and opens it with one press ([#4505](https://github.com/k2b-dev/cloud/issues/4505)) ([18db15b](https://github.com/k2b-dev/cloud/commit/18db15b7e9269ac19a9894b78dead196a8a32656))
* **ui:** v2 address chips, named chip removal, and a phone sheet with grip and close ([#4273](https://github.com/k2b-dev/cloud/issues/4273)) ([6a02921](https://github.com/k2b-dev/cloud/commit/6a029212c015e9b1e4f592bd7a466e31ea170733))
* **ui:** v2 avatars show pictures, tables sort by their heads, and buttons and fields know busy and disabled ([#4116](https://github.com/k2b-dev/cloud/issues/4116)) ([6600a52](https://github.com/k2b-dev/cloud/commit/6600a5298c99f890522dd678f705270785913885))
* **ui:** v2 choices show faces and take several, sliders read a unit, selects keep an address's domain ([#4267](https://github.com/k2b-dev/cloud/issues/4267)) ([829441b](https://github.com/k2b-dev/cloud/commit/829441b431d82dc3cdd38b88fb9cd61aaafa8baa))
* **ui:** v2 column grip runs on the ui-sdk Resizable ([#4105](https://github.com/k2b-dev/cloud/issues/4105)) ([959e6cd](https://github.com/k2b-dev/cloud/commit/959e6cda771d412c38fc55784298541d349b9244))
* **ui:** v2 controls get keyboard, focus and drag behaviour from the ui-sdk core ([#4053](https://github.com/k2b-dev/cloud/issues/4053)) ([c4568da](https://github.com/k2b-dev/cloud/commit/c4568da2b2dbf16a6a85907a3682089940f0c703))
* **ui:** v2 dates are picked from a calendar, and a filter's own period opens it as a submenu ([#4159](https://github.com/k2b-dev/cloud/issues/4159)) ([d57291e](https://github.com/k2b-dev/cloud/commit/d57291e50bb749778736a56f10d37ea27fc00a0b))
* **ui:** v2 drag onto a target holds touch through the ui-sdk core ([#4107](https://github.com/k2b-dev/cloud/issues/4107)) ([f6e9ff3](https://github.com/k2b-dev/cloud/commit/f6e9ff349b372d94e20f912607e56f66d0985690))
* **ui:** v2 forms offer tags, images, codes, disabled choices, field actions and disclosures ([#4191](https://github.com/k2b-dev/cloud/issues/4191)) ([fef72a0](https://github.com/k2b-dev/cloud/commit/fef72a07be09533a914ebbbe6729befa8bdc262d))
* **ui:** v2 head controls stay on the phone, and only the floating button's twin and a detail's close leave the head ([#4373](https://github.com/k2b-dev/cloud/issues/4373)) ([edaab8e](https://github.com/k2b-dev/cloud/commit/edaab8e76c74ede8b5ff40ada00f6a16420a92b5))
* **ui:** v2 head popovers stay on the phone and facts load in their shape ([#4164](https://github.com/k2b-dev/cloud/issues/4164)) ([8f56b22](https://github.com/k2b-dev/cloud/commit/8f56b2226d6f67a783923c7e81ef2a6a84cfa638))
* **ui:** v2 listbox, tree and per-owner toasts on the ui-sdk core ([#4108](https://github.com/k2b-dev/cloud/issues/4108)) ([8d10b20](https://github.com/k2b-dev/cloud/commit/8d10b2071f473a0401bb8218d7ba4ba14f9d4984))
* **ui:** v2 lists declare their filters, sorts and groups and keep them in the URL ([#4135](https://github.com/k2b-dev/cloud/issues/4135)) ([e0e8c69](https://github.com/k2b-dev/cloud/commit/e0e8c695b2cd8e83361d14f305db8794c1c02813))
* **ui:** v2 lists show their filters as readable statements and pick values asynchronously ([#4136](https://github.com/k2b-dev/cloud/issues/4136)) ([7d89bce](https://github.com/k2b-dev/cloud/commit/7d89bceb519a6f92b17f8d7eeaf6f47ad4292854))
* **ui:** v2 menus, popovers and toasts ([#4109](https://github.com/k2b-dev/cloud/issues/4109)) ([99b941d](https://github.com/k2b-dev/cloud/commit/99b941d93d6e1d58e4c7738f4f86e0cae06997ae))
* **ui:** v2 navigation and tables show trees ([#4187](https://github.com/k2b-dev/cloud/issues/4187)) ([4fca75e](https://github.com/k2b-dev/cloud/commit/4fca75ebda3681c9170b37b31edbddd00938512c))
* **ui:** v2 pages announce state changes to assistive technology through one live region ([#4341](https://github.com/k2b-dev/cloud/issues/4341)) ([8d5566d](https://github.com/k2b-dev/cloud/commit/8d5566d8ac48439c44f254a8422ca0144de96bd3))
* **ui:** v2 RangeBar shows several ranges in one row ([#4553](https://github.com/k2b-dev/cloud/issues/4553)) ([4d91e8e](https://github.com/k2b-dev/cloud/commit/4d91e8e6fd12110370c88f4481274e0c26d52fc1))
* **ui:** v2 Rating lets people rate with 1 to 5 stars ([#4555](https://github.com/k2b-dev/cloud/issues/4555)) ([e6422ea](https://github.com/k2b-dev/cloud/commit/e6422eaee7e5e5b2912f1c0a91b4240fc2ac8f75))
* **ui:** v2 rows part with a quiet line, and the open row takes the tint of the app it belongs to ([#4355](https://github.com/k2b-dev/cloud/issues/4355)) ([0190356](https://github.com/k2b-dev/cloud/commit/01903569451c0088cba04fe66356fe20beb3c502))
* **ui:** v2 rows show they are selected and an open detail on the phone has one way back ([#4111](https://github.com/k2b-dev/cloud/issues/4111)) ([bcf947a](https://github.com/k2b-dev/cloud/commit/bcf947a74e8bce5aedc1ac9398699ba1ee6cc300))
* **ui:** v2 sidebar and tab counts are written in the page's language, in full ([#4254](https://github.com/k2b-dev/cloud/issues/4254)) ([405ff88](https://github.com/k2b-dev/cloud/commit/405ff88abe29ec78703be9709c8bb51b154d656b))
* **ui:** v2 sparks side by side share one scale with max ([#4527](https://github.com/k2b-dev/cloud/issues/4527)) ([319a184](https://github.com/k2b-dev/cloud/commit/319a184982ecbd475ba145ba327785f72815e25f))
* **ui:** v2 table names give way to their marks, measureV2Layout sees controls that stick out, and a list section can fold ([#4366](https://github.com/k2b-dev/cloud/issues/4366)) ([87a9566](https://github.com/k2b-dev/cloud/commit/87a956610d34ed90cddd73cdd75b394cd7af1668))
* **ui:** v2 tabs open their menu, sidebars fold and carry deeds, and a reader's state and phone title stay whole ([#4125](https://github.com/k2b-dev/cloud/issues/4125)) ([d69b391](https://github.com/k2b-dev/cloud/commit/d69b391071273df3a53dc85421f07b45da5a4595))
* **ui:** v2 things and people show their face ([#4208](https://github.com/k2b-dev/cloud/issues/4208)) ([0180631](https://github.com/k2b-dev/cloud/commit/018063197b24d51dbc49c0af12cf760d9cf941bb))


### Bug Fixes

* **ci:** unit shards balance by fresh measured times, and the slowest suites split ([#4404](https://github.com/k2b-dev/cloud/issues/4404)) ([723464e](https://github.com/k2b-dev/cloud/commit/723464eb40fde2c9b94247f5296973995f181268))
* **cloud:** no icon stands as an empty box for a filled Tabler name ([#4560](https://github.com/k2b-dev/cloud/issues/4560)) ([e79bd17](https://github.com/k2b-dev/cloud/commit/e79bd1790c386970d9973923a0047774c471822f))
* **notebooks:** graph displays that show only their icon name themselves on hover ([#4319](https://github.com/k2b-dev/cloud/issues/4319)) ([94d76b1](https://github.com/k2b-dev/cloud/commit/94d76b1f528b373a645640c2d1f4e24d898019ae))
* **test:** a wait for a page's client names the scripts that did not load ([#4418](https://github.com/k2b-dev/cloud/issues/4418)) ([7952e9b](https://github.com/k2b-dev/cloud/commit/7952e9b685ce6595635c18686b4177ded8f06f7a))
* **test:** the shared test DOM provides matchMedia, so a v2 menu renders in behavior tests ([#4471](https://github.com/k2b-dev/cloud/issues/4471)) ([b633c2c](https://github.com/k2b-dev/cloud/commit/b633c2c343d7b9fee1b1e0e9ee9ed65a55d99863))
* **ui:** a bar never shows two '&', whatever the app's '&' is named or what menu follows it ([#4472](https://github.com/k2b-dev/cloud/issues/4472)) ([0995fa3](https://github.com/k2b-dev/cloud/commit/0995fa3be143e9ed63c291a0d205dad3c460fbd4))
* **ui:** a chart's first time label never draws over the lowest value label ([#4316](https://github.com/k2b-dev/cloud/issues/4316)) ([7632dcd](https://github.com/k2b-dev/cloud/commit/7632dcda9de732970f69a49f87e08133700b46dc))
* **ui:** a choice in a v2 menu always arrives, also when core holds no props for its group ([#4431](https://github.com/k2b-dev/cloud/issues/4431)) ([03e7e24](https://github.com/k2b-dev/cloud/commit/03e7e2469fa77dde1b9a4d794832376da6cbd452))
* **ui:** a choice in a v2 table row's menu no longer opens the row ([#4282](https://github.com/k2b-dev/cloud/issues/4282)) ([d131f37](https://github.com/k2b-dev/cloud/commit/d131f3780bacd7f068198306379cc4df627c860e))
* **ui:** a filter editor keeps a field's focus while it is typed in ([#4155](https://github.com/k2b-dev/cloud/issues/4155)) ([787ba31](https://github.com/k2b-dev/cloud/commit/787ba3176a5a54f6b55fa646eb0bf60154dccdaa))
* **ui:** a focused v2 tab that hides for lack of room hands its focus to the menu tab ([#4508](https://github.com/k2b-dev/cloud/issues/4508)) ([5a68bc5](https://github.com/k2b-dev/cloud/commit/5a68bc59b38c065d3584fe0d54e728f28a1042d6))
* **ui:** a jump to a place far down scrolls only the v2 pane, never the frame around it ([#4496](https://github.com/k2b-dev/cloud/issues/4496)) ([63a056c](https://github.com/k2b-dev/cloud/commit/63a056c315a79c98ae67e448e60dba65692f0f59))
* **ui:** a record's head on the phone keeps avatar, name and actions in one row ([#4465](https://github.com/k2b-dev/cloud/issues/4465)) ([c19e19a](https://github.com/k2b-dev/cloud/commit/c19e19a7d64b17052d703f37450fa6540efb969d))
* **ui:** a small island inside a v2 container keeps the container's layout ([#4193](https://github.com/k2b-dev/cloud/issues/4193)) ([14ed3ec](https://github.com/k2b-dev/cloud/commit/14ed3ecc310c45100e402279bd8a87843197b642))
* **ui:** a split inside a v2 column counts for the room of its workspace, and side belongs on the inner column ([#4434](https://github.com/k2b-dev/cloud/issues/4434)) ([6d2f5e3](https://github.com/k2b-dev/cloud/commit/6d2f5e30885e8aa5ec61ec7cd7087d4a8a88a181))
* **ui:** a state timeline draws each state in its own colour and keeps lane names and legend in the chart ([#4233](https://github.com/k2b-dev/cloud/issues/4233)) ([8fbc654](https://github.com/k2b-dev/cloud/commit/8fbc6544a685e5a488347038caf187e0507b6439))
* **ui:** a status row's selection bar folds the actions without room into a "&" menu and never cuts its count ([#4330](https://github.com/k2b-dev/cloud/issues/4330)) ([8129491](https://github.com/k2b-dev/cloud/commit/8129491ef5efcbe5f8d601baf14484863f50e3db))
* **ui:** a table in v2 reading text keeps its cells apart and reads like a small table ([#4381](https://github.com/k2b-dev/cloud/issues/4381)) ([878e2e4](https://github.com/k2b-dev/cloud/commit/878e2e4899739ed6426b8a22d403c23d5902467e))
* **ui:** a test's cleanup waits for the library's own loads ([#4499](https://github.com/k2b-dev/cloud/issues/4499)) ([06c1eb8](https://github.com/k2b-dev/cloud/commit/06c1eb85434aa32ed0f8f8f304b8ae61b1efd6e6))
* **ui:** a v2 bar's fold comes to rest when a part at its end has an auto margin ([#4575](https://github.com/k2b-dev/cloud/issues/4575)) ([70a462e](https://github.com/k2b-dev/cloud/commit/70a462e309fac62ee708358eb31f770536393595))
* **ui:** a v2 button with words and a label is named by its label ([#4384](https://github.com/k2b-dev/cloud/issues/4384)) ([bc4f048](https://github.com/k2b-dev/cloud/commit/bc4f048795a7a96d49aca67951ff237533ac1a29))
* **ui:** a v2 detail named far longer than its bar keeps a few letters of its way back ([#4416](https://github.com/k2b-dev/cloud/issues/4416)) ([b8f2970](https://github.com/k2b-dev/cloud/commit/b8f29700a0acb5f8831360d14c9b323a73521c89))
* **ui:** a v2 dialog that opens without a key gives its first focus without a ring ([#4128](https://github.com/k2b-dev/cloud/issues/4128)) ([07177f0](https://github.com/k2b-dev/cloud/commit/07177f07e7991a43be70d2836c855420116073b0))
* **ui:** a v2 hydration wait that fails names Playwright's reason ([#4129](https://github.com/k2b-dev/cloud/issues/4129)) ([ece75b0](https://github.com/k2b-dev/cloud/commit/ece75b02e317698caced565ad0112afd3e91b6c6))
* **ui:** a v2 nav list shows no scroll bar of its own, so its rows reach the sidebar's edge in WebKit ([#4507](https://github.com/k2b-dev/cloud/issues/4507)) ([6541e11](https://github.com/k2b-dev/cloud/commit/6541e11b8b7a626f6944e9cf317141f93e31a6a3))
* **ui:** a v2 nav without a tree and a menu without a panel load none of their code ([#4449](https://github.com/k2b-dev/cloud/issues/4449)) ([89e179c](https://github.com/k2b-dev/cloud/commit/89e179c886739502b065adbcdc954fee1faca9b9))
* **ui:** a v2 path keeps the page it names whole and folds its middle places into a menu ([#4395](https://github.com/k2b-dev/cloud/issues/4395)) ([856c65c](https://github.com/k2b-dev/cloud/commit/856c65cbfc9ac992191cf3d5f44ac25819f00e59))
* **ui:** a v2 section's way to all of it stands under its rows on their text edge ([#4337](https://github.com/k2b-dev/cloud/issues/4337)) ([b56a722](https://github.com/k2b-dev/cloud/commit/b56a722d96b0d8b576804acc67dfdc2acdcd568c))
* **ui:** a v2 sheet on the phone stays on the bottom when its content resizes or a script scrolls in it ([#4168](https://github.com/k2b-dev/cloud/issues/4168)) ([ca69f1f](https://github.com/k2b-dev/cloud/commit/ca69f1f6566b8d4bbbc23430c789c5678394d2f0))
* **ui:** a v2 sheet stands in place at once when the person asks for less motion ([#4459](https://github.com/k2b-dev/cloud/issues/4459)) ([bcdd2d1](https://github.com/k2b-dev/cloud/commit/bcdd2d194e643afcd84eeeda37f0cd9f38c9d3f0))
* **ui:** a v2 status row keeps its end on the phone, folding what has no room into +n ([#4426](https://github.com/k2b-dev/cloud/issues/4426)) ([ebd617e](https://github.com/k2b-dev/cloud/commit/ebd617eaf4e7c9b09268391516a7b4435a67edf9))
* **ui:** a v2 text of several lines no longer measures itself after it has left the page ([#4520](https://github.com/k2b-dev/cloud/issues/4520)) ([bf70bd3](https://github.com/k2b-dev/cloud/commit/bf70bd3204663465445c046b25559052c807b895))
* **ui:** calendar all-day titles and hour labels are never cut at the view's sticky edges ([#4375](https://github.com/k2b-dev/cloud/issues/4375)) ([f54774e](https://github.com/k2b-dev/cloud/commit/f54774e9f7b3eb15f50837b940bcf0faeaf64b28))
* **ui:** charts in a v2 screen use the v2 tokens ([#4140](https://github.com/k2b-dev/cloud/issues/4140)) ([e2b4f89](https://github.com/k2b-dev/cloud/commit/e2b4f89891bcdc69356999612aba7808f335dc6a))
* **ui:** charts size and style themselves in a v2-only page and load in their own shape ([#4158](https://github.com/k2b-dev/cloud/issues/4158)) ([4d9c79a](https://github.com/k2b-dev/cloud/commit/4d9c79ad845c5fa40d055c5d62a13019c9a81dc0))
* **ui:** crowded calendar bands keep whole lines and collapse into +n ([#4265](https://github.com/k2b-dev/cloud/issues/4265)) ([7145fb5](https://github.com/k2b-dev/cloud/commit/7145fb53e562884a6043388701ac515f64919968))
* **ui:** many places in a v2 sidebar scroll between its head and its foot ([#4516](https://github.com/k2b-dev/cloud/issues/4516)) ([d6b42ef](https://github.com/k2b-dev/cloud/commit/d6b42ef6d71bb63da1716407e377323f5055af3c))
* **ui:** on the phone the floating main action leaves room under the last row ([#4454](https://github.com/k2b-dev/cloud/issues/4454)) ([3fc8335](https://github.com/k2b-dev/cloud/commit/3fc8335a5a21abd6265092e07376a14cf2994948))
* **ui:** screens no longer open hints about where something moved ([#4500](https://github.com/k2b-dev/cloud/issues/4500)) ([f4a70ab](https://github.com/k2b-dev/cloud/commit/f4a70abb61a07d6aec7b192dd13deb504ca86199))
* **ui:** settled() waits for real frames under Playwright's clock ([#4429](https://github.com/k2b-dev/cloud/issues/4429)) ([951cfc5](https://github.com/k2b-dev/cloud/commit/951cfc5f93d4fe298b97bb9ada5d9afa8278c545))
* **ui:** status row parts, segments and section actions give way without losing words or names ([#4221](https://github.com/k2b-dev/cloud/issues/4221)) ([70eb6d7](https://github.com/k2b-dev/cloud/commit/70eb6d748a48ebe89b603d6047deb5a43c776a8e))
* **ui:** the island error fallback loads only its own modules, not the button, marks and states of every app ([#4333](https://github.com/k2b-dev/cloud/issues/4333)) ([35ee1f6](https://github.com/k2b-dev/cloud/commit/35ee1f6e3ded87a8590a9348c77dbebd584527ce))
* **ui:** the island-transparent v2.css no longer makes WebKit restyle on every change ([#4329](https://github.com/k2b-dev/cloud/issues/4329)) ([cd18a32](https://github.com/k2b-dev/cloud/commit/cd18a32289f4e370f5e0caf962b8eb4afb552567))
* **ui:** the swatch of a v2 colour field says which colour it holds ([#4318](https://github.com/k2b-dev/cloud/issues/4318)) ([c2a5ef7](https://github.com/k2b-dev/cloud/commit/c2a5ef7a3399a05775dbde9405dad6ce2fae826b))
* **ui:** the v2 outline counts one primary action per page and per open dialog ([#4117](https://github.com/k2b-dev/cloud/issues/4117)) ([3a53bdc](https://github.com/k2b-dev/cloud/commit/3a53bdcfa48a5c50da1bc6efa57d0895d2f38b23))
* **ui:** the v2 select typeahead test waits for the highlight before it presses Enter ([#4127](https://github.com/k2b-dev/cloud/issues/4127)) ([abc463b](https://github.com/k2b-dev/cloud/commit/abc463b456d42a8e00828a57d7aed5f61a3282e8))
* **ui:** v1 colour props take only colours ([#4363](https://github.com/k2b-dev/cloud/issues/4363)) ([25762ef](https://github.com/k2b-dev/cloud/commit/25762efef15eeb4599561e0d2758b3cf6468be65))
* **ui:** v2 colour props take only colours ([#4359](https://github.com/k2b-dev/cloud/issues/4359)) ([5e93d02](https://github.com/k2b-dev/cloud/commit/5e93d021d92d818afc58d47e1e2d9fcde499509f))
* **ui:** v2 grips show only on hover, focus and drag, and hold their line beside an overflowing table ([#4291](https://github.com/k2b-dev/cloud/issues/4291)) ([b575719](https://github.com/k2b-dev/cloud/commit/b575719ad37e0115561565d66fa8a693a73decf0))
* **ui:** v2 grips stay in sight, a record's head keeps clear of its actions, and a narrow digest stacks ([#4119](https://github.com/k2b-dev/cloud/issues/4119)) ([1d66541](https://github.com/k2b-dev/cloud/commit/1d66541db2a6cd672b5eb1b50bf026802fbe75c1))
* **ui:** v2 list addresses keep their commas readable ([#4138](https://github.com/k2b-dev/cloud/issues/4138)) ([018753f](https://github.com/k2b-dev/cloud/commit/018753ff12ab1d973334245671b179ae85bf944b))
* **ui:** v2 pane and column grips resize by pointer and keyboard ([#4217](https://github.com/k2b-dev/cloud/issues/4217)) ([d4f6cee](https://github.com/k2b-dev/cloud/commit/d4f6ceee6f1d70000d832c8cdacb9b5216d6d9c4))
* **ui:** v2 section titles wrap, checks carry a description, and multi-line fields grow with their words ([#4216](https://github.com/k2b-dev/cloud/issues/4216)) ([8fc7645](https://github.com/k2b-dev/cloud/commit/8fc7645287cdc4298eea0da3a4904ac049a027f0))
* **ui:** v2 splits, multi-line fields, phone sheets and status rows hold their shape ([#4161](https://github.com/k2b-dev/cloud/issues/4161)) ([d64273b](https://github.com/k2b-dev/cloud/commit/d64273b189fa3b06048f012b26ceeaacf3548e8a))
* **ui:** v2 text fields send autocomplete and keyboard hints in the server's markup ([#4184](https://github.com/k2b-dev/cloud/issues/4184)) ([938dc1a](https://github.com/k2b-dev/cloud/commit/938dc1ad9ba58cddf6fda7a8cc2a5a56ce72ff64))
* **ui:** v2 Ticks fit their cell and keep their newest slots in view ([#4428](https://github.com/k2b-dev/cloud/issues/4428)) ([3726dc6](https://github.com/k2b-dev/cloud/commit/3726dc695f946085abf15414990b6e61dbc45b56))


### Performance Improvements

* **ui:** the shipped v2.css gives an inner part of a primitive no way through an island wrapper ([#4357](https://github.com/k2b-dev/cloud/issues/4357)) ([fbfc73b](https://github.com/k2b-dev/cloud/commit/fbfc73bc03c68734d848ea1c8f3a6eb3ef27bf43))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/stdlib bumped from 0.36.1 to 0.37.0
  * devDependencies
    * @k2b/ssr bumped from 0.23.2 to 0.24.0
  * peerDependencies
    * @k2b/ssr bumped from ^0.12.0 || ^0.13.0 || ^0.14.0 || ^0.15.0 || ^0.16.0 || ^0.17.0 || ^0.18.0 || ^0.19.0 || ^0.20.0 || ^0.21.0 || ^0.22.0 || ^0.23.0 || ^0.24.0 to ^0.24.0
</details>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).