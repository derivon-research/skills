# Third-Party Notices

The self-contained `derivon-mindmap/scripts/render-documents.mjs` bundle includes:

- [marked](https://github.com/markedjs/marked) - MIT
- [marked-katex-extension](https://github.com/UziTech/marked-katex-extension) - MIT
- [KaTeX](https://github.com/KaTeX/KaTeX) - MIT
- [parse5](https://github.com/inikulin/parse5) - MIT
- [entities](https://github.com/fb55/entities) - BSD-2-Clause
- [css-tree](https://github.com/csstree/csstree) - MIT
- [image-dimensions](https://github.com/sindresorhus/image-dimensions) - MIT
- [srcset](https://github.com/sindresorhus/srcset) - MIT
- [mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown) - MIT
- [mdast-util-gfm](https://github.com/syntax-tree/mdast-util-gfm) - MIT
- [micromark-extension-gfm](https://github.com/micromark/micromark-extension-gfm) - MIT
- [mdast-util-math](https://github.com/syntax-tree/mdast-util-math) - MIT
- [micromark-extension-math](https://github.com/micromark/micromark-extension-math) - MIT

These packages bundle their MIT-licensed unified/micromark utility dependencies.
The development dependency tree also includes `mdn-data` under CC0-1.0 and
`source-map-js` under BSD-3-Clause; their code is not included in the generated
renderer bundle. Package metadata and license files are available through the
locked npm dependencies. The repository's own source is licensed under the MIT
License in `LICENSE`.
