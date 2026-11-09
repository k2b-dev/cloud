### Keep checked byte-limit failures visible through stream adapters

- **What happened:** The signed AI reader reported a bridge outage when a file exceeded its declared size. Its model-loop fixture also dispatched Core calls to the Example endpoint, and German presentation omitted nested file and tool fields.
- **Root cause:** The stream adapter replaced the checked size error with a generic error before the reader could classify it. The bridge also lacked a status mapping for incomplete file reads. The fixture inherited a different app's endpoint; presentation described only the new top-level fields.
- **Error class:** Loss of error identity at a transport boundary; incomplete fixture and schema presentation wiring.
- **Guard:** Signed C4 tests retain the strict 400 size-limit assertion, check incomplete reads and exercise the complete model loop. Stream transport tests distinguish checked size failures from private provider errors. The built-in presentation test enumerates nested schema fields.
