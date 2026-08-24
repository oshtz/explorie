import { describe, expect, it } from 'vitest';
import {
  formatExifDate,
  formatGps,
  hasPhotoMetadata,
  isImageMetadataPath,
  parseImageMetadata,
} from './imageMetadata';

const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const TYPE_UNDEFINED = 7;

type TiffValue = string | number | number[] | Uint8Array;

type TiffTag = {
  tag: number;
  type: number;
  value: TiffValue;
};

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function typeSize(type: number): number {
  return [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8][type] ?? 1;
}

function encodePayload(
  type: number,
  value: TiffValue,
  little: boolean
): { count: number; bytes: Uint8Array } {
  if (typeof value === 'string') {
    const raw = new TextEncoder().encode(value.endsWith('\0') ? value : `${value}\0`);
    return { count: raw.length, bytes: raw };
  }
  if (value instanceof Uint8Array) {
    return { count: value.length, bytes: value };
  }
  const numbers = Array.isArray(value) ? value : [value];
  if (type === TYPE_RATIONAL) {
    const bytes = new Uint8Array(numbers.length * 4);
    const view = new DataView(bytes.buffer);
    numbers.forEach((n, i) => view.setUint32(i * 4, n ?? 0, little));
    return { count: numbers.length / 2, bytes };
  }
  const size = typeSize(type);
  const bytes = new Uint8Array(numbers.length * size);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < numbers.length; i += 1) {
    const n = numbers[i] ?? 0;
    const offset = i * size;
    if (type === TYPE_SHORT) view.setUint16(offset, n, little);
    else if (type === TYPE_LONG) view.setUint32(offset, n, little);
    else bytes[offset] = n & 0xff;
  }
  return { count: numbers.length, bytes };
}

function encodeTiff(options: {
  little?: boolean;
  ifd0: TiffTag[];
  exif?: TiffTag[];
  gps?: TiffTag[];
}): Uint8Array {
  const little = options.little !== false;
  const ifd0Tags = [...options.ifd0];
  if (options.exif) ifd0Tags.push({ tag: 0x8769, type: TYPE_LONG, value: 0 });
  if (options.gps) ifd0Tags.push({ tag: 0x8825, type: TYPE_LONG, value: 0 });
  ifd0Tags.sort((a, b) => a.tag - b.tag);

  const ifdSize = (count: number) => 2 + 12 * count + 4;

  let cursor = 8;
  const ifd0Offset = cursor;
  cursor += ifdSize(ifd0Tags.length);

  const preparedIfd0 = ifd0Tags.map((tag) => {
    if (tag.tag === 0x8769 || tag.tag === 0x8825) {
      return { tag, count: 1, bytes: new Uint8Array(4), extra: false, extraOffset: 0 };
    }
    const payload = encodePayload(tag.type, tag.value, little);
    const extra = payload.bytes.length > 4;
    const extraOffset = extra ? cursor : 0;
    if (extra) cursor += payload.bytes.length;
    return { tag, ...payload, extra, extraOffset };
  });

  let exifOffset = 0;
  let preparedExif: typeof preparedIfd0 = [];
  if (options.exif) {
    const exifTags = [...options.exif].sort((a, b) => a.tag - b.tag);
    exifOffset = cursor;
    cursor += ifdSize(exifTags.length);
    preparedExif = exifTags.map((tag) => {
      const payload = encodePayload(tag.type, tag.value, little);
      const extra = payload.bytes.length > 4;
      const extraOffset = extra ? cursor : 0;
      if (extra) cursor += payload.bytes.length;
      return { tag, ...payload, extra, extraOffset };
    });
  }

  let gpsOffset = 0;
  let preparedGps: typeof preparedIfd0 = [];
  if (options.gps) {
    const gpsTags = [...options.gps].sort((a, b) => a.tag - b.tag);
    gpsOffset = cursor;
    cursor += ifdSize(gpsTags.length);
    preparedGps = gpsTags.map((tag) => {
      const payload = encodePayload(tag.type, tag.value, little);
      const extra = payload.bytes.length > 4;
      const extraOffset = extra ? cursor : 0;
      if (extra) cursor += payload.bytes.length;
      return { tag, ...payload, extra, extraOffset };
    });
  }

  const buf = new Uint8Array(cursor);
  const view = new DataView(buf.buffer);
  if (little) {
    buf[0] = 0x49;
    buf[1] = 0x49;
    view.setUint16(2, 42, true);
    view.setUint32(4, ifd0Offset, true);
  } else {
    buf[0] = 0x4d;
    buf[1] = 0x4d;
    view.setUint16(2, 42, false);
    view.setUint32(4, ifd0Offset, false);
  }

  const writeIfd = (
    offset: number,
    entries: typeof preparedIfd0,
    pointerValues: Record<number, number>
  ) => {
    view.setUint16(offset, entries.length, little);
    entries.forEach((entry, index) => {
      const pos = offset + 2 + index * 12;
      view.setUint16(pos, entry.tag.tag, little);
      view.setUint16(pos + 2, entry.tag.type, little);
      view.setUint32(pos + 4, entry.count, little);
      const pointer = pointerValues[entry.tag.tag];
      if (pointer !== undefined) {
        view.setUint32(pos + 8, pointer, little);
        return;
      }
      if (entry.extra) {
        buf.set(entry.bytes, entry.extraOffset);
        view.setUint32(pos + 8, entry.extraOffset, little);
      } else {
        buf.set(entry.bytes, pos + 8);
      }
    });
    view.setUint32(offset + 2 + entries.length * 12, 0, little);
  };

  writeIfd(ifd0Offset, preparedIfd0, {
    0x8769: exifOffset,
    0x8825: gpsOffset,
  });
  if (options.exif) writeIfd(exifOffset, preparedExif, {});
  if (options.gps) writeIfd(gpsOffset, preparedGps, {});
  return buf;
}

function encodeIptc(fields: { caption?: string; keywords?: string[] }): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const keyword of fields.keywords ?? []) {
    const value = new TextEncoder().encode(keyword);
    const out = new Uint8Array(5 + value.length);
    out[0] = 0x1c;
    out[1] = 2;
    out[2] = 25;
    out[3] = (value.length >> 8) & 0xff;
    out[4] = value.length & 0xff;
    out.set(value, 5);
    parts.push(out);
  }
  if (fields.caption) {
    const value = new TextEncoder().encode(fields.caption);
    const out = new Uint8Array(5 + value.length);
    out[0] = 0x1c;
    out[1] = 2;
    out[2] = 120;
    out[3] = (value.length >> 8) & 0xff;
    out[4] = value.length & 0xff;
    out.set(value, 5);
    parts.push(out);
  }
  return concat(parts);
}

function encodeIrb(iptc: Uint8Array): Uint8Array {
  const size = iptc.length;
  const pad = size % 2 === 1 ? new Uint8Array([0]) : new Uint8Array(0);
  const header = new Uint8Array(4 + 2 + 2 + 4);
  header.set([0x38, 0x42, 0x49, 0x4d]);
  header[4] = 0x04;
  header[5] = 0x04;
  header[6] = 0x00;
  header[7] = 0x00;
  header[8] = (size >>> 24) & 0xff;
  header[9] = (size >>> 16) & 0xff;
  header[10] = (size >>> 8) & 0xff;
  header[11] = size & 0xff;
  return concat([header, iptc, pad]);
}

function jpegMarker(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return concat([new Uint8Array([0xff, marker, (length >> 8) & 0xff, length & 0xff]), payload]);
}

function jpegWithSegments(options: {
  exif?: Uint8Array;
  iptc?: Uint8Array;
  width?: number;
  height?: number;
}): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (options.exif) {
    const payload = concat([new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]), options.exif]);
    parts.push(jpegMarker(0xe1, payload));
  }
  if (options.iptc) {
    const ident = new Uint8Array([
      0x50, 0x68, 0x6f, 0x74, 0x6f, 0x73, 0x68, 0x6f, 0x70, 0x20, 0x33, 0x2e, 0x30, 0x00,
    ]);
    parts.push(jpegMarker(0xed, concat([ident, encodeIrb(options.iptc)])));
  }
  if (options.width && options.height) {
    const sof = new Uint8Array(15);
    sof[0] = 8;
    sof[1] = (options.height >> 8) & 0xff;
    sof[2] = options.height & 0xff;
    sof[3] = (options.width >> 8) & 0xff;
    sof[4] = options.width & 0xff;
    sof[5] = 3;
    parts.push(jpegMarker(0xc0, sof));
  }
  parts.push(new Uint8Array([0xff, 0xd9]));
  return concat(parts);
}

function jpegWithExif(): Uint8Array {
  return jpegWithSegments({
    exif: encodeTiff({
      ifd0: [
        { tag: 0x010f, type: TYPE_ASCII, value: 'Canon' },
        { tag: 0x0110, type: TYPE_ASCII, value: 'EOS R5' },
        { tag: 0x0132, type: TYPE_ASCII, value: '2024:03:15 14:30:00' },
        { tag: 0x0100, type: TYPE_SHORT, value: 4032 },
        { tag: 0x0101, type: TYPE_SHORT, value: 3024 },
      ],
      exif: [{ tag: 0x9003, type: TYPE_ASCII, value: '2024:03:15 14:30:00' }],
    }),
  });
}

function jpegWithIptc(): Uint8Array {
  return jpegWithSegments({
    iptc: encodeIptc({ caption: 'Harbor at dusk', keywords: ['travel', 'boats'] }),
  });
}

function jpegWithGps(): Uint8Array {
  return jpegWithSegments({
    exif: encodeTiff({
      ifd0: [{ tag: 0x010f, type: TYPE_ASCII, value: 'Sony' }],
      gps: [
        { tag: 0x0001, type: TYPE_ASCII, value: 'N' },
        { tag: 0x0002, type: TYPE_RATIONAL, value: [37, 1, 46, 1, 0, 1] },
        { tag: 0x0003, type: TYPE_ASCII, value: 'W' },
        { tag: 0x0004, type: TYPE_RATIONAL, value: [122, 1, 25, 1, 0, 1] },
      ],
    }),
  });
}

describe('isImageMetadataPath', () => {
  it('accepts JPEG, TIFF and compatible stills', () => {
    expect(isImageMetadataPath('C:/Photos/IMG_0001.JPEG')).toBe(true);
    expect(isImageMetadataPath('/tmp/scan.tiff')).toBe(true);
    expect(isImageMetadataPath('n.png')).toBe(true);
    expect(isImageMetadataPath('clip.mp4')).toBe(false);
  });
});

describe('parseImageMetadata', () => {
  it('reads camera, date and dimensions from JPEG EXIF', () => {
    expect(parseImageMetadata(jpegWithExif())).toEqual({
      camera: 'Canon EOS R5',
      date: '2024:03:15 14:30:00',
      width: 4032,
      height: 3024,
    });
  });

  it('reads IPTC caption and keywords from JPEG APP13', () => {
    expect(parseImageMetadata(jpegWithIptc())).toEqual({
      caption: 'Harbor at dusk',
      keywords: ['travel', 'boats'],
    });
  });

  it('returns empty metadata for a JPEG without EXIF or IPTC', () => {
    expect(parseImageMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({});
    expect(hasPhotoMetadata({})).toBe(false);
  });

  it('parses GPS without treating missing capture fields as an error', () => {
    const meta = parseImageMetadata(jpegWithGps());
    expect(meta.camera).toBe('Sony');
    expect(meta.gps?.latitude).toBeCloseTo(37.766666, 5);
    expect(meta.gps?.longitude).toBeCloseTo(-122.416666, 5);
  });

  it('reads TIFF IFD0 and IPTC tag 33723', () => {
    const iptc = encodeIptc({ caption: 'Studio catalog', keywords: ['catalog'] });
    const tiff = encodeTiff({
      ifd0: [
        { tag: 0x0100, type: TYPE_SHORT, value: 800 },
        { tag: 0x0101, type: TYPE_SHORT, value: 600 },
        { tag: 0x010f, type: TYPE_ASCII, value: 'Nikon' },
        { tag: 0x0110, type: TYPE_ASCII, value: 'Nikon Z8' },
        { tag: 0x83bb, type: TYPE_UNDEFINED, value: iptc },
      ],
    });
    expect(parseImageMetadata(tiff)).toEqual({
      camera: 'Nikon Z8',
      width: 800,
      height: 600,
      caption: 'Studio catalog',
      keywords: ['catalog'],
    });
  });

  it('returns empty metadata for truncated or unknown bytes', () => {
    expect(parseImageMetadata(new Uint8Array([0, 1, 2]))).toEqual({});
    expect(parseImageMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02]))).toEqual({});
  });
});

describe('formatters', () => {
  it('normalizes EXIF timestamps and GPS decimals', () => {
    expect(formatExifDate('2024:03:15 14:30:00')).toBe('2024-03-15T14:30:00');
    expect(formatGps({ latitude: 37.5, longitude: -122.25 })).toBe('37.500000, -122.250000');
  });
});
