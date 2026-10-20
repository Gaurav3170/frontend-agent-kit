import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkImgTags, findUnoptimizedImages, imageProblems } from "../src/tools/find-unoptimized-images.js";
import { parseImageHeader } from "../src/lib/image-size.js";
import { deps, incompressible, project } from "./helpers.js";

function png(width: number, height: number, padTo = 0): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0);
  header.writeUInt32BE(0x0d0a1a0a, 4);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, incompressible(Math.max(0, padTo - 24))]);
}

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment to skip, then SOF0 with the frame size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe("image headers", () => {
  it("reads PNG, JPEG, GIF and WebP sizes", () => {
    assert.deepEqual(parseImageHeader(png(4000, 3000)), { format: "png", width: 4000, height: 3000 });
    assert.deepEqual(parseImageHeader(jpeg(1920, 1080)), { format: "jpeg", width: 1920, height: 1080 });
    const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1");
    assert.deepEqual(parseImageHeader(gif), { format: "gif", width: 320, height: 240 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBPVP8X", 8, "ascii");
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);
    assert.deepEqual(parseImageHeader(webp), { format: "webp", width: 800, height: 600 });
  });

  it("recognises SVG and rejects unknown files", () => {
    assert.deepEqual(parseImageHeader(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')), { format: "svg" });
    assert.equal(parseImageHeader(Buffer.from("not an image")), null);
  });
});

describe("imageProblems", () => {
  const limits = { maxBytes: 200_000, maxWidth: 2560 };

  it("flags heavy, oversized and legacy-format files", () => {
    const problems = imageProblems(900_000, { format: "png", width: 4000, height: 3000 }, limits);
    assert.equal(problems.length, 3);
    assert.match(problems.join(" "), /over 200 kB/);
    assert.match(problems.join(" "), /4000px wide/);
    assert.match(problems.join(" "), /WebP/);
  });

  it("leaves small icons and modern formats alone", () => {
    assert.deepEqual(imageProblems(4_000, { format: "png", width: 32, height: 32 }, limits), []);
    assert.deepEqual(imageProblems(150_000, { format: "avif", width: 1600, height: 900 }, limits), []);
  });

  it("suggests video for large GIFs and SVGO for large SVGs", () => {
    assert.match(imageProblems(500_000, { format: "gif", width: 400, height: 300 }, limits).join(" "), /<video>/);
    assert.match(imageProblems(80_000, { format: "svg" }, limits).join(" "), /SVGO/);
  });
});

describe("checkImgTags", () => {
  it("flags missing size, alt and loading attributes", () => {
    const [issue] = checkImgTags('<div>\n  <img src="/hero.jpg">\n</div>', "index.html", { usesNext: false });
    assert.equal(issue!.line, 2);
    assert.equal(issue!.problems.length, 3);
  });

  it("accepts a complete tag, including the LCP image with fetchpriority", () => {
    assert.deepEqual(checkImgTags('<img src="/a.jpg" width="800" height="600" alt="A shoe" loading="lazy">', "a.html", { usesNext: false }), []);
    assert.deepEqual(checkImgTags('<img src="/b.jpg" width={800} height={600} alt="" fetchPriority="high" />', "b.tsx", { usesNext: false }), []);
  });

  it("doesn't guess about tags that spread props", () => {
    assert.deepEqual(checkImgTags("<img {...props} />", "c.tsx", { usesNext: false }), []);
  });

  it("suggests next/image in a Next.js project's JSX only", () => {
    const tag = '<img src="/a.jpg" width="1" height="1" alt="" loading="lazy" />';
    assert.match(checkImgTags(tag, "page.tsx", { usesNext: true })[0]!.problems[0]!, /next\/image/);
    assert.deepEqual(checkImgTags(tag, "public/legal.html", { usesNext: true }), []);
  });

  it("ignores <img> inside strings and regexes in scripts", () => {
    const code = 'if (text.includes("<img")) scan();\nconst re = /<img\\b([^>]*)>/g;\nconst html = `<img src="${src}">`;\nreturn <img src="/z.jpg" alt="Z" />;';
    const issues = checkImgTags(code, "scan.jsx", { usesNext: false });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.line, 4);
  });

  it("ignores <img> inside fenced code samples", () => {
    const mdx = 'Some text\n\n```html\n<img src="/x.jpg">\n```\n\n<img src="/y.jpg" alt="Y" />';
    const issues = checkImgTags(mdx, "post.mdx", { usesNext: false });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.line, 7);
  });
});

describe("find_unoptimized_images", () => {
  it("scans files and markup, skipping node_modules and build output", async () => {
    const dir = project({
      "package.json": { dependencies: { next: "15.0.0" } },
      "public/hero.png": png(4000, 2000, 300_000),
      "public/icon.png": png(32, 32),
      "node_modules/pkg/big.png": png(5000, 5000, 400_000),
      ".next/static/media/big.png": png(5000, 5000, 400_000),
      "src/app/page.tsx": 'export default () => <img src="/hero.png" />;',
    });
    const text = await findUnoptimizedImages.run({ projectDir: dir }, deps());
    assert.match(text, /Scanned 2 image files and 1 source file/);
    assert.match(text, /`public\/hero\.png` \| 300 kB \| 4000×2000 \|/);
    assert.doesNotMatch(text, /icon\.png|`node_modules\/|`\.next\//);
    assert.match(text, /`src\/app\/page\.tsx:1`/);
    assert.match(text, /1× next\/image would add/);
  });

  it("reports a clean project as green", async () => {
    const text = await findUnoptimizedImages.run({ projectDir: project({ "package.json": {}, "index.html": "<p>hi</p>" }) }, deps());
    assert.match(text, /No problems found/);
  });
});
