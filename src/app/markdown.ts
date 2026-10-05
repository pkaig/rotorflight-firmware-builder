/**
 * A small Markdown-to-HTML renderer for the in-app user manual
 * (docs/Rotorflight-firmware-build-manual.md). It covers what the manual uses —
 * headings (with GitHub-style ids, so its contents links work), paragraphs,
 * lists, tables, fenced code, block quotes, rules, images, links, code spans,
 * bold and italics — and nothing more, to keep the app free of dependencies.
 *
 * All text is HTML-escaped; links may only be http(s), mailto, in-page (#…) or
 * relative, so the manual cannot inject markup or script.
 */

export interface RenderOptions {
  /** Rewrites a relative image path, e.g. "images/x.png" -> "/docs/images/x.png". */
  imageBase?: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** GitHub's heading id: lower case, punctuation dropped, spaces to hyphens. */
export function slug(heading: string): string {
  const text = heading.replace(/`([^`]*)`/g, "$1").replace(/\*\*?|__?/g, "");
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\- _]/gu, "").replace(/ /g, "-");
}

function safeUrl(url: string): string | undefined {
  if (/^(https?:|mailto:)/i.test(url) || url.startsWith("#")) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return undefined; // javascript:, data: and the like
  return url; // relative
}

/**
 * Inline formatting. Code spans are swapped for placeholders first, so nothing
 * inside them is formatted, while formatting around them (**`dialout`**, or a
 * link whose text is code) still pairs up; they are put back at the end.
 */
export function inline(text: string, opts: RenderOptions = {}): string {
  const codes: string[] = [];
  let s = esc(text.replace(/`([^`]+)`/g, (_, code: string) => `\u0000${codes.push(code) - 1}\u0000`));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, src: string) => {
    const url = safeUrl(src);
    if (!url) return alt;
    const full = opts.imageBase && !/^[a-z]+:|^\//i.test(url) ? opts.imageBase + url : url;
    return `<img src="${full}" alt="${alt}" loading="lazy">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
    const url = safeUrl(href);
    if (!url) return label;
    const external = /^https?:/i.test(url);
    return `<a href="${url}"${external ? ' target="_blank" rel="noopener"' : ""}>${label}</a>`;
  });
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${esc(codes[Number(i)]!)}</code>`);
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*```/;
const RULE = /^\s*(-{3,}|\*{3,})\s*$/;
const ITEM = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** Is this line the start of some block other than a paragraph? */
function startsBlock(line: string, next: string | undefined): boolean {
  return HEADING.test(line) || FENCE.test(line) || RULE.test(line) || ITEM.test(line) ||
    /^\s*>/.test(line) || (line.trim().startsWith("|") && !!next && TABLE_SEP.test(next));
}

export function renderMarkdown(md: string, opts: RenderOptions = {}): string {
  return blocks(md.replace(/\r\n?/g, "\n").split("\n"), opts);
}

function blocks(lines: string[], opts: RenderOptions): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }

    if (FENCE.test(line)) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]!); i++) body.push(lines[i]!);
      i++; // the closing fence
      out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      const level = h[1]!.length;
      out.push(`<h${level} id="${esc(slug(h[2]!))}">${inline(h[2]!, opts)}</h${level}>`);
      i++;
      continue;
    }

    if (RULE.test(line)) { out.push("<hr>"); i++; continue; }

    if (line.trim().startsWith("|") && lines[i + 1] && TABLE_SEP.test(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.trim().startsWith("|"); i++) rows.push(cells(lines[i]!));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c, opts)}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, opts)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${blocks(body, opts)}</blockquote>`);
      continue;
    }

    const first = line.match(ITEM);
    if (first) {
      const ordered = /\d/.test(first[2]!);
      const indent = first[1]!.length;
      const items: string[][] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(ITEM);
        if (m && m[1]!.length === indent) {
          items.push([m[3]!]);
          i++;
          continue;
        }
        // Continuation: an indented line, or a blank line followed by one.
        const cur = lines[i]!;
        const indented = (s: string | undefined) => !!s && /^\s{2,}\S/.test(s) && (s.match(/^\s*/)![0].length > indent);
        if (indented(cur)) { items.at(-1)!.push(cur.replace(new RegExp(`^\\s{0,${indent + 4}}`), "")); i++; continue; }
        if (!cur.trim() && indented(lines[i + 1])) { items.at(-1)!.push(""); i++; continue; }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => {
        // A one-paragraph item stays inline; anything more renders as blocks.
        const simple = it.every((l) => l.trim() && !startsBlock(l, undefined));
        return `<li>${simple ? inline(it.join(" "), opts) : blocks(it, opts)}</li>`;
      }).join("")}</${tag}>`);
      continue;
    }

    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !(para.length && startsBlock(lines[i]!, lines[i + 1])); i++) {
      para.push(lines[i]!.trim());
    }
    out.push(`<p>${inline(para.join(" "), opts)}</p>`);
  }
  return out.join("\n");
}
