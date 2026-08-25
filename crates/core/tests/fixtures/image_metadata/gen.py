"""Regenerates the committed image-metadata fixtures. Run with Pillow installed."""
import struct
from PIL import Image, PngImagePlugin

W, H = 6, 4

def iim(datasets):
    out = bytearray()
    for record, dataset, value in datasets:
        data = value.encode("latin-1")
        out += bytes([0x1C, record, dataset]) + struct.pack(">H", len(data)) + data
    return bytes(out)

def irb(iim_bytes):
    out = bytearray(b"8BIM")
    out += struct.pack(">H", 0x0404)
    out += b"\x00\x00"  # empty Pascal name, padded to even
    out += struct.pack(">I", len(iim_bytes))
    out += iim_bytes
    if len(iim_bytes) % 2:
        out += b"\x00"
    return bytes(out)

def app13(iim_bytes):
    payload = b"Photoshop 3.0\x00" + irb(iim_bytes)
    return b"\xff\xed" + struct.pack(">H", len(payload) + 2) + payload

def raw_profile(iim_bytes):
    hexed = iim_bytes.hex()
    lines = [hexed[i:i + 78] for i in range(0, len(hexed), 78)]
    return "\niptc\n%8d\n%s\n" % (len(iim_bytes), "\n".join(lines))

DATASETS = [
    (2, 5, "Fixture object"),
    (2, 25, "alpha"),
    (2, 25, "beta"),
    (2, 80, "Fixture Photographer"),
    (2, 105, "Fixture headline"),
    (2, 120, "Fixture caption"),
]

def exif_block():
    exif = Image.Exif()
    exif[0x010F] = "Explorie"
    exif[0x0110] = "Fixture Cam 1"
    exif[0x0131] = "explorie-fixtures"
    ifd = exif.get_ifd(0x8769)
    ifd[0x9003] = "2024:03:01 12:34:56"
    ifd[0x9004] = "2024:03:01 12:34:56"
    return exif

img = Image.new("RGB", (W, H), (32, 96, 160))

# JPEG with EXIF + IPTC (APP13 spliced in after SOI, ahead of APP1).
img.save("camera.jpg", quality=90, exif=exif_block())
raw = open("camera.jpg", "rb").read()
open("camera.jpg", "wb").write(raw[:2] + app13(iim(DATASETS)) + raw[2:])

# JPEG with no EXIF and no IPTC.
img.save("bare.jpg", quality=90)

# PNG with EXIF plus an ImageMagick-style raw IPTC profile.
meta = PngImagePlugin.PngInfo()
meta.add_text("Raw profile type iptc", raw_profile(iim(DATASETS)))
img.save("camera.png", exif=exif_block(), pnginfo=meta)

# TIFF with EXIF only, including a capture timestamp in the EXIF IFD.
tiff_exif = Image.Exif()
tiff_exif[0x010F] = "Explorie"
tiff_exif[0x0110] = "Fixture Cam 1"
tiff_exif[0x0131] = "explorie-fixtures"
tiff_exif[0x0132] = "2024:03:01 12:34:56"
tiff_exif.get_ifd(0x8769)[0x9003] = "2024:03:01 12:34:56"
tiff_exif.get_ifd(0x8769)[0x9004] = "2024:03:01 12:34:56"
img.save("camera.tif", dpi=(72, 72), exif=tiff_exif.tobytes())

# Valid TIFF with no EXIF/IPTC and no resolution tags. This exercises the
# writer fallback for files produced by scanners and simple image libraries.
img.save("bare.tif")

# Unsupported type for the empty-state path.
img.save("unsupported.gif")
