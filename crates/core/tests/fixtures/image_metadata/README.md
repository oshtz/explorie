# Image metadata fixtures

6x4 pixel images used by `crates/core/tests/image_metadata.rs`.

| File | Contents |
| --- | --- |
| `camera.jpg` | EXIF (Make, Model, Software, DateTimeOriginal, CreateDate) plus an IPTC IIM block in an APP13 Photoshop resource |
| `camera.png` | The same EXIF plus IPTC stored as an ImageMagick `Raw profile type iptc` text chunk |
| `camera.tif` | EXIF only (Make, Model, Software, ModifyDate, DateTimeOriginal) |
| `bare.jpg` | No EXIF and no IPTC |
| `bare.tif` | No EXIF/IPTC and no resolution tags |
| `unsupported.gif` | Not an EXIF/IPTC-capable container; drives the empty-state path |

Regenerate with `python gen.py` (needs Pillow). The IPTC blocks are assembled by
`gen.py` rather than by explorie's own writer, so the parser is tested against
third-party output.
