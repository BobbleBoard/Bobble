# Mermaid, bundled

`mermaid.min.js` is **Mermaid 11.17.2** (MIT, © Knut Sveidqvist and contributors,
<https://github.com/mermaid-js/mermaid>) — the single self-contained browser build,
`dist/mermaid.min.js` from the npm package, unmodified. `LICENSE` beside it is the
package's own. The build carries the notices of what it bundles (d3, dagre, cytoscape,
DOMPurify, KaTeX, roughjs, …) inline at the end of the file.

**Why it is here.** The `diagram` tool (VQ-10, deliverables/research/visual-quality.md
§2.2.3) draws the model's Mermaid in a hidden, sandboxed window in the app
(`electron/gen/diagram-render.ts`). the user approved bundling it (deliverables/research/PLAN.md
Q28: "Bundle Mermaid (MIT, 3.5 MB) for `diagram`? … yes"). Bundled, so diagrams draw
offline and the bytes are the same in dev and in the packaged app
(`electron-builder.yml` copies this folder to `<Resources>/mermaid`).

**Why a file and not a dependency.** The npm package unpacks to 84 MB across twenty-odd
runtime dependencies; the app runs exactly this one 3.5 MB file, in a browser window,
and nothing imports the package.

**Provenance, pinned.**

| | |
|---|---|
| version | 11.17.2 (npm, published 2026-08-25) |
| tarball integrity (sha512, as the registry lists it and `npm pack` verified) | `sha512-V6K3C8EBdEsPFZXSKMJe6ppQOENxuHARr9GvHX4hh47lAbhMRD9qf4oEK7LoaRQxULMa80/qt5gHO73aCleBBg==` |
| `mermaid.min.js` sha256 | `581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8` |
| size | 3,572,661 bytes |

The renderer refuses a `mermaid.min.js` whose sha256 is not the pinned one, and
`electron/gen/diagram-page.test.ts` holds this file and this table to the same pin.

**To update:** `npm pack mermaid@<version>`, check the tarball's sha512 against
`npm view mermaid@<version> dist.integrity`, copy `package/dist/mermaid.min.js` and
`package/LICENSE` here, and change the version and sha256 in this table and in
`MERMAID_VERSION` / `MERMAID_SHA256` (`electron/gen/diagram-page.ts`). Then run the
diagram probes: a major version may move the DOM the post-pass reads.
