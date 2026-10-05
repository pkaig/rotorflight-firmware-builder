import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderMarkdown, slug } from "../src/app/markdown.ts";

test("headings get GitHub-style ids", () => {
  assert.equal(slug("4. Linux: serial and USB permissions (dialout and udev)"), "4-linux-serial-and-usb-permissions-dialout-and-udev");
  assert.equal(slug("Step 1 — Identify your board"), "step-1--identify-your-board");
  assert.match(renderMarkdown("## The `dialout` group"), /<h2 id="the-dialout-group">The <code>dialout<\/code> group<\/h2>/);
});

test("inline formatting, links and images", () => {
  const html = renderMarkdown("**Bold**, *italic*, `a*b*c` and [a link](#x) ![pic](images/a.png) [site](https://example.com)",
    { imageBase: "/docs/" });
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>a\*b\*c<\/code>/); // nothing formatted inside code
  // Formatting around code still pairs up.
  assert.match(renderMarkdown("join **`dialout`** first"), /<strong><code>dialout<\/code><\/strong>/);
  assert.match(html, /<a href="#x">a link<\/a>/);
  assert.match(html, /<img src="\/docs\/images\/a.png" alt="pic"/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener">site<\/a>/);
});

test("escapes HTML and refuses script links", () => {
  const html = renderMarkdown('<script>alert(1)</script> [x](javascript:alert(1)) `<b>`');
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("javascript:"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
});

test("tables, lists, fenced code and block quotes", () => {
  const md = [
    "| A | B |", "|---|---|", "| `x` | **y** |", "",
    "1. one", "2. two", "",
    "- item", "  continued", "",
    "```sh", "echo 'a < b'", "```", "",
    "> **Safety:** blades off.",
  ].join("\n");
  const html = renderMarkdown(md);
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td><code>x<\/code><\/td><td><strong>y<\/strong><\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<ul><li>item continued<\/li><\/ul>/);
  assert.match(html, /<pre><code class="lang-sh">echo 'a &lt; b'<\/code><\/pre>/);
  assert.match(html, /<blockquote><p><strong>Safety:<\/strong> blades off.<\/p><\/blockquote>/);
});

test("a list item can hold a code block", () => {
  const html = renderMarkdown(["- run this:", "", "  ```sh", "  make", "  ```", "", "  then this."].join("\n"));
  assert.match(html, /<li><p>run this:<\/p>\n<pre><code class="lang-sh">make<\/code><\/pre>\n<p>then this.<\/p><\/li>/);
});

test("the user manual renders, with every contents link and image resolving", () => {
  const md = readFileSync(new URL("../docs/Rotorflight-firmware-build-manual.md", import.meta.url), "utf8");
  const html = renderMarkdown(md, { imageBase: "/docs/" });
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(anchors.length > 10);
  for (const a of anchors) assert.ok(ids.has(a), `missing anchor #${a}`);
  const images = [...html.matchAll(/<img src="\/docs\/(images\/[^"]+)"/g)].map((m) => m[1]!);
  assert.ok(images.length >= 20);
  for (const img of images) readFileSync(new URL(`../docs/${img}`, import.meta.url)); // throws if missing
  assert.ok(!/[^`]\*\*[^*]/.test(html.replace(/<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/g, "")), "unrendered bold");
});
