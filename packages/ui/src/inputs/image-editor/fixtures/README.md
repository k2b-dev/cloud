The fixed photo fixture is a 1600 × 1067 resampling of the repository's
`packages/venue/public/templates/cafe-banner.jpg`. It exercises natural image
detail rather than a synthetic gradient. The PNG is an opaque blue logo with
transparent surroundings and a half-transparent red square, rasterized at the
same dimensions. Neither fixture contains personal data.

The engine browser test compares a 400 px render with the downsampled 1600 px
render and checks alpha against geometry alone. The images stay fixed so
renderer regressions cannot be hidden by changing test inputs.
