# Vendored GPUI macOS backend

This crate is copied from `zed-industries/zed` at commit
`1d029c5ff5654fb1b1e8caf4462993c8ee13a133`, the GPUI revision pinned by
Explorie.

It carries one upstream fix from commit
`20a93f6195ca8e9f0a748038317a5efe1be3e482`:
`gpui_macos: Fix glyph rendering when fonts share a PostScript name (#57250)`.

Cargo patches only `gpui_macos`; the rest of GPUI remains on the original
pinned revision. Remove this patch when Explorie moves to a GPUI revision that
already contains the fix.
