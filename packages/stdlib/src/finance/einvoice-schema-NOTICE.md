# E-Invoice schemas

The embedded EN16931 XSD files are the ZUGFeRD 2.5 / Factur-X 1.09 profile
schemas, distributed by FeRD and FNFE-MPE. They were obtained from the
`schema/en16931` directory of `@stackforge-eu/factur-x@1.2.0`, which normalizes
filenames and schemaLocation references. Schema text is preserved byte-for-byte
inside the generated TypeScript string map; no library implementation is copied.

- Upstream distribution: https://www.ferd-net.de/publikationen-produkte/publikationen/detailseite/zugferd-25-english
- Source snapshot: https://www.npmjs.com/package/@stackforge-eu/factur-x/v/1.2.0
- Technical artifact licensing: https://www.ferd-net.de/ueber-uns/ressourcen-1/veroeffentlichungen/haftungsausschluss-und-nutzungsrechte

FeRD licenses the technical artifacts (schemas and Schematron) under Apache 2.0.
See `einvoice-schema-LICENSE.txt`. The stdlib implementation remains ISC.
The package includes XSD checks only, not the Schematron rules.
