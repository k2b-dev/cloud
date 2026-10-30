export const DOCUMENTED_IMAGE_FORMS = ["attach://GHI789", "https://example.test/a.png"].flatMap((href) =>
  [
    { name: "plain", suffix: "", width: null, height: null, title: null },
    { name: "width and height", suffix: " =400x300", width: 400, height: 300, title: null },
    { name: "width only", suffix: " =400x", width: 400, height: null, title: null },
    { name: "height only", suffix: " =x300", width: null, height: 300, title: null },
    { name: "plain with title", suffix: ' "Ground floor"', width: null, height: null, title: "Ground floor" },
    { name: "width and height with title", suffix: ' =400x300 "Ground floor"', width: 400, height: 300, title: "Ground floor" },
    { name: "width only with title", suffix: ' =400x "Ground floor"', width: 400, height: null, title: "Ground floor" },
    { name: "height only with title", suffix: ' =x300 "Ground floor"', width: null, height: 300, title: "Ground floor" },
  ].map(({ name, suffix, width, height, title }) => ({
    name: `${href}: ${name}`,
    markdown: `![Floor plan](${href}${suffix})`,
    href,
    alt: "Floor plan",
    title,
    width,
    height,
  })),
);
