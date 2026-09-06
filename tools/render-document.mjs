import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import katexCss from 'katex/dist/katex.min.css';

const markdownRenderer = new Marked({ gfm: true }, markedKatex({ throwOnError: false, strict: false }));

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function renderDocument(markdown, title) {
  const body = markdownRenderer.parse(markdown, { async: false }).trim();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
${baseStyle().split('\n').map((line) => `    ${line}`).join('\n')}
${katexCss.split('\n').map((line) => `    ${line}`).join('\n')}
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}

function baseStyle() {
  return `:root { color: #202422; background: #fff; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color-scheme: light; }
* { box-sizing: border-box; }
body { max-width: 820px; margin: 0 auto; padding: 32px; line-height: 1.7; }
h1, h2, h3 { line-height: 1.3; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { overflow: auto; padding: 12px; background: #f4f5f2; }
blockquote { margin-left: 0; padding-left: 14px; border-left: 3px solid #799084; color: #5d6761; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 7px 9px; border: 1px solid #d5d8d3; text-align: left; }
img, svg, canvas { max-width: 100%; }
.katex-display { overflow-x: auto; overflow-y: hidden; padding: 4px 0; }
button, input, select, textarea { font: inherit; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #2f7087; outline-offset: 2px; }
@media (max-width: 560px) { body { padding: 18px; } table { display: block; overflow-x: auto; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; } }`;
}
