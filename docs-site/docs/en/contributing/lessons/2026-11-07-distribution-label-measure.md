### Distribution charts inferred geometry and meaning from labels

- **What happened:** Pareto cut labels to seven letters despite available space, omitted the plus sign for growth, and treated any spelling of “Rest” as a remainder. Zero-value treemap cells could be inspected inside the title.
- **Root cause:** Labels used a second 296px width factor; remainder sorting inspected display text; zero-area layout placeholders received interactive metadata.
- **Error class:** Presentation text controls domain meaning, or drawing metadata ignores actual geometry.
- **Guard:** Core tests check natural-width labels, signed change, explicit `rest: true`, and the absence of zero-area inspection targets. JSON/model tests preserve the remainder flag. Browser tests continue to check label boxes and keyboard navigation.
