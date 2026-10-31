# Changelog

## [0.2.0](https://github.com/k2b-dev/cloud/compare/npm-editor-v0.1.1...npm-editor-v0.2.0) (2026-10-31)


### Features

* **editor:** show block anchors as quiet labels in Notebooks and the notes site ([#2186](https://github.com/k2b-dev/cloud/issues/2186)) ([a81989c](https://github.com/k2b-dev/cloud/commit/a81989c55bd7c4f78646ffa11e6347136053a9cc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.38.0 to 0.38.1

## [0.1.1](https://github.com/k2b-dev/cloud/compare/npm-editor-v0.1.0...npm-editor-v0.1.1) (2026-10-31)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.37.0 to 0.38.0

## 0.1.0 (2026-10-30)


### Features

* **editor:** add @k2b/editor with editor, toolbar, bubble and slash menu on one shared state ([#2123](https://github.com/k2b-dev/cloud/issues/2123)) ([3a70b08](https://github.com/k2b-dev/cloud/commit/3a70b08a86b0e3225f262818c216f53a6c48b976))
* **editor:** add the @k2b/editor/collab add-on and use it in Notebooks and Mail ([#2143](https://github.com/k2b-dev/cloud/issues/2143)) ([4421675](https://github.com/k2b-dev/cloud/commit/4421675758c698e76ce4448bfe730639f5eb5ce7))
* **editor:** move formulas, charts and tables into @k2b/editor; @k2b/cloud keeps its exports ([#2146](https://github.com/k2b-dev/cloud/issues/2146)) ([85d5b6c](https://github.com/k2b-dev/cloud/commit/85d5b6cf35ef05a5bd36b2d0bb2310f659fcd058))
* **editor:** move the Notebooks Markdown presentation into @k2b/editor/markdown ([#2142](https://github.com/k2b-dev/cloud/issues/2142)) ([24bf06c](https://github.com/k2b-dev/cloud/commit/24bf06c50b1425b641a5b0fd6aad64fc121a21cf))
* **editor:** show images a host resolves to blob: URLs ([#2165](https://github.com/k2b-dev/cloud/issues/2165)) ([4787ef9](https://github.com/k2b-dev/cloud/commit/4787ef99e75fb11c1c2ea24c02695ceb434e060d))
* **notebooks:** build the note toolbar and slash menu from @k2b/editor ([#2134](https://github.com/k2b-dev/cloud/issues/2134)) ([4b855eb](https://github.com/k2b-dev/cloud/commit/4b855ebbacb72351fcc07d555d8d1185c2ca75e7))


### Bug Fixes

* **editor:** reconfigure reactive extensions after the editor update, never during it ([#2182](https://github.com/k2b-dev/cloud/issues/2182)) ([884964f](https://github.com/k2b-dev/cloud/commit/884964f34776a49bad2e71901a5d8db42d7fb9bf))


### Performance Improvements

* **editor:** load Mermaid, KaTeX and code languages only when a host uses them ([#2166](https://github.com/k2b-dev/cloud/issues/2166)) ([d50a731](https://github.com/k2b-dev/cloud/commit/d50a731deb9b906e2b2ed012505f50a562827402))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @k2b/ui bumped from 0.36.0 to 0.37.0
