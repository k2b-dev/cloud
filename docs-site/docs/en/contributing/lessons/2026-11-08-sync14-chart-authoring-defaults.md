### Chart authoring types required data supplied by a default

- **What happened:** Generated Code chart types rejected grouped and compared bars that omitted category data, although the chart validator accepted their aligned series.
- **Root cause:** Chart authoring declarations projected the schema's output, where the new defaulted data array is required, instead of the input an author supplies.
- **Error class:** Output schema used to describe caller input.
- **Guard:** The generated SDK typecheck compiles a grouped chart description and a compared `Chart.Bar` call without category data. Chart authoring declarations project the input schema.
