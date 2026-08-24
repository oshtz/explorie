export type ImageGps = {
  latitude: number;
  longitude: number;
};

export type ImageMetadata = {
  camera?: string;
  date?: string;
  width?: number;
  height?: number;
  caption?: string;
  keywords?: string[];
  gps?: ImageGps;
};

const IMAGE_METADATA_EXTENSIONS = new Set(['jpg', 'jpeg', 'tif', 'tiff', 'webp', 'png']);

const TYPE_BYTE = 1;
const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const TYPE_UNDEFINED = 7;
const TYPE_SLONG = 9;

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8];

const TAG_IMAGE_WIDTH = 0x0100;
const TAG_IMAGE_LENGTH = 0x0101;
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_DATETIME = 0x0132;
const TAG_IPTC = 0x83bb;
const TAG_PHOTOSHOP = 0x8649;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;

const GPS_LAT_REF = 0x0001;
const GPS_LAT = 0x0002;
const GPS_LON_REF = 0x0003;
const GPS_LON = 0x0004;

type ParsedTag = {
  type: number;
  count: number;
  valueOffset: number;
  nbytes: number;
};

export function isImageMetadataPath(path: string): boolean {
  const clean = path.split(/[?#]/, 1)[0] ?? '';
  const name = clean.split(/[/\\]/).pop() ?? clean;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_METADATA_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function hasPhotoMetadata(meta: ImageMetadata): boolean {
  return Boolean(
    meta.camera ||
    meta.date ||
    meta.width ||
    meta.height ||
    meta.caption ||
    (meta.keywords && meta.keywords.length > 0) ||
    meta.gps
  );
}

export function parseImageMetadata(input: Uint8Array | ArrayBuffer): ImageMetadata {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 4) return {};
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return parseJpeg(bytes);
    if (isPng(bytes)) return parsePng(bytes);
    if (isTiff(bytes, 0)) return parseTiffAt(bytes, 0);
    if (isWebp(bytes)) return parseWebp(bytes);
    return {};
  } catch {
    return {};
  }
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function isTiff(bytes: Uint8Array, offset: number): boolean {
  if (offset + 4 > bytes.length) return false;
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  return (
    (b0 === 0x49 && b1 === 0x49 && b2 === 0x2a && b3 === 0x00) ||
    (b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2a)
  );
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodeBytes(bytes: Uint8Array): string {
  let end = bytes.length;
  const nul = bytes.indexOf(0);
  if (nul >= 0) end = nul;
  const slice = bytes.subarray(0, end);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(slice).trim();
  } catch {
    return new TextDecoder('latin1').decode(slice).trim();
  }
}

function formatCamera(make?: string, model?: string): string | undefined {
  const m = make?.trim();
  const d = model?.trim();
  if (m && d) {
    if (d.toLowerCase().startsWith(m.toLowerCase())) return d;
    return `${m} ${d}`;
  }
  return d || m || undefined;
}

function merge(target: ImageMetadata, extra: ImageMetadata): ImageMetadata {
  const keywords =
    extra.keywords && extra.keywords.length > 0
      ? extra.keywords
      : target.keywords && target.keywords.length > 0
        ? target.keywords
        : undefined;
  return {
    camera: extra.camera ?? target.camera,
    date: extra.date ?? target.date,
    width: extra.width ?? target.width,
    height: extra.height ?? target.height,
    caption: extra.caption ?? target.caption,
    keywords,
    gps: extra.gps ?? target.gps,
  };
}

function parseJpeg(bytes: Uint8Array): ImageMetadata {
  let meta: ImageMetadata = {};
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    while (i < bytes.length && bytes[i] === 0xff) i += 1;
    if (i >= bytes.length) break;
    const marker = bytes[i];
    i += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 2 > bytes.length) break;
    const length = (bytes[i] << 8) | bytes[i + 1];
    if (length < 2 || i + length > bytes.length) break;
    const payload = bytes.subarray(i + 2, i + length);
    i += length;
    if (marker === 0xe1) {
      meta = merge(meta, parseApp1(payload));
    } else if (marker === 0xed) {
      meta = merge(meta, parseApp13(payload));
    } else if (marker >= 0xc0 && marker <= 0xc3 && payload.length >= 5) {
      const height = (payload[1] << 8) | payload[2];
      const width = (payload[3] << 8) | payload[4];
      if (width > 0 && height > 0) {
        meta = merge(meta, { width, height });
      }
    }
  }
  return meta;
}

function parseApp1(payload: Uint8Array): ImageMetadata {
  if (payload.length >= 6 && decodeBytes(payload.subarray(0, 6)).toLowerCase() === 'exif') {
    return parseTiffAt(payload, 0);
  }
  return {};
}

function parseApp13(payload: Uint8Array): ImageMetadata {
  const ident = 'Photoshop 3.0';
  const identBytes = new TextEncoder().encode(ident);
  let offset = 0;
  if (
    payload.length > identBytes.length &&
    identBytes.every((b, idx) => payload[idx] === b) &&
    payload[identBytes.length] === 0
  ) {
    offset = identBytes.length + 1;
  }
  return parseIrb(payload.subarray(offset));
}

function parseIrb(data: Uint8Array): ImageMetadata {
  let meta: ImageMetadata = {};
  let i = 0;
  while (i + 10 <= data.length) {
    if (data[i] !== 0x38 || data[i + 1] !== 0x42 || data[i + 2] !== 0x49 || data[i + 3] !== 0x4d) {
      i += 1;
      continue;
    }
    i += 4;
    const id = (data[i] << 8) | data[i + 1];
    i += 2;
    if (i >= data.length) break;
    const nameLen = data[i];
    i += 1 + nameLen;
    if ((1 + nameLen) % 2 === 1) i += 1;
    if (i + 4 > data.length) break;
    const size = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
    i += 4;
    if (i + size > data.length) break;
    if (id === 0x0404) {
      meta = merge(meta, parseIptc(data.subarray(i, i + size)));
    }
    i += size;
    if (size % 2 === 1) i += 1;
  }
  return meta;
}

function parseIptc(data: Uint8Array): ImageMetadata {
  const keywords: string[] = [];
  let caption: string | undefined;
  let i = 0;
  while (i + 5 <= data.length) {
    if (data[i] !== 0x1c) {
      i += 1;
      continue;
    }
    const record = data[i + 1];
    const dataset = data[i + 2];
    let len = (data[i + 3] << 8) | data[i + 4];
    let header = 5;
    if (len >= 0x8000) {
      const n = len & 0x7fff;
      if (n === 0 || i + 5 + n > data.length) break;
      len = 0;
      for (let k = 0; k < n; k += 1) len = (len << 8) | data[i + 5 + k];
      header = 5 + n;
    }
    if (i + header + len > data.length) break;
    const value = decodeBytes(data.subarray(i + header, i + header + len));
    if (record === 2 && dataset === 120 && value) caption = value;
    if (record === 2 && dataset === 25 && value) keywords.push(value);
    i += header + len;
  }
  return {
    caption,
    keywords: keywords.length > 0 ? keywords : undefined,
  };
}

function parseTiffAt(bytes: Uint8Array, offset: number): ImageMetadata {
  let start = offset;
  if (
    start + 6 <= bytes.length &&
    bytes[start] === 0x45 &&
    bytes[start + 1] === 0x78 &&
    bytes[start + 2] === 0x69 &&
    bytes[start + 3] === 0x66
  ) {
    start += 6;
  }
  if (!isTiff(bytes, start)) return {};
  const view = viewOf(bytes);
  const little = bytes[start] === 0x49;
  const ifd0Rel = readU32(view, start + 4, little);
  if (ifd0Rel === undefined) return {};
  return metadataFromIfd(view, bytes, start, ifd0Rel, little, 0);
}

function metadataFromIfd(
  view: DataView,
  bytes: Uint8Array,
  tiffStart: number,
  ifdRel: number,
  little: boolean,
  depth: number
): ImageMetadata {
  if (depth > 8) return {};
  const tags = readIfd(view, tiffStart, ifdRel, little);
  let meta = tagsToMetadata(view, bytes, tags, little);

  const exifPtr = readPointer(view, tags.get(TAG_EXIF_IFD), little);
  if (exifPtr !== undefined) {
    const exifTags = readIfd(view, tiffStart, exifPtr, little);
    meta = merge(meta, tagsToMetadata(view, bytes, exifTags, little));
  }

  const gpsPtr = readPointer(view, tags.get(TAG_GPS_IFD), little);
  if (gpsPtr !== undefined) {
    const gpsTags = readIfd(view, tiffStart, gpsPtr, little);
    const gps = readGps(view, gpsTags, little);
    if (gps) meta = merge(meta, { gps });
  }

  const nextAbs = tiffStart + ifdRel;
  const count = readU16(view, nextAbs, little);
  if (count !== undefined) {
    const nextPtr = readU32(view, nextAbs + 2 + count * 12, little);
    if (nextPtr && nextPtr !== 0) {
      meta = merge(meta, metadataFromIfd(view, bytes, tiffStart, nextPtr, little, depth + 1));
    }
  }

  return meta;
}

function readIfd(
  view: DataView,
  tiffStart: number,
  ifdRel: number,
  little: boolean
): Map<number, ParsedTag> {
  const map = new Map<number, ParsedTag>();
  const abs = tiffStart + ifdRel;
  const count = readU16(view, abs, little);
  if (count === undefined || count > 256) return map;
  for (let i = 0; i < count; i += 1) {
    const entry = abs + 2 + i * 12;
    const tag = readU16(view, entry, little);
    const type = readU16(view, entry + 2, little);
    const countN = readU32(view, entry + 4, little);
    if (tag === undefined || type === undefined || countN === undefined) break;
    const unit = TYPE_SIZE[type] ?? 0;
    if (!unit || countN > 0x100000) continue;
    const nbytes = unit * countN;
    let valueOffset: number;
    if (nbytes <= 4) {
      valueOffset = entry + 8;
    } else {
      const rel = readU32(view, entry + 8, little);
      if (rel === undefined) continue;
      valueOffset = tiffStart + rel;
    }
    if (valueOffset < 0 || valueOffset + nbytes > view.byteLength) continue;
    map.set(tag, { type, count: countN, valueOffset, nbytes });
  }
  return map;
}

function tagsToMetadata(
  view: DataView,
  bytes: Uint8Array,
  tags: Map<number, ParsedTag>,
  little: boolean
): ImageMetadata {
  const make = readAsciiTag(bytes, tags.get(TAG_MAKE));
  const model = readAsciiTag(bytes, tags.get(TAG_MODEL));
  const date =
    readAsciiTag(bytes, tags.get(TAG_DATETIME_ORIGINAL)) ??
    readAsciiTag(bytes, tags.get(TAG_DATETIME));
  const width =
    readNumberTag(view, tags.get(TAG_PIXEL_X), little) ??
    readNumberTag(view, tags.get(TAG_IMAGE_WIDTH), little);
  const height =
    readNumberTag(view, tags.get(TAG_PIXEL_Y), little) ??
    readNumberTag(view, tags.get(TAG_IMAGE_LENGTH), little);

  let meta: ImageMetadata = {
    camera: formatCamera(make, model),
    date: date || undefined,
    width,
    height,
  };

  const iptcTag = tags.get(TAG_IPTC);
  if (iptcTag) {
    meta = merge(
      meta,
      parseIptc(bytes.subarray(iptcTag.valueOffset, iptcTag.valueOffset + iptcTag.nbytes))
    );
  }
  const photoshopTag = tags.get(TAG_PHOTOSHOP);
  if (photoshopTag) {
    meta = merge(
      meta,
      parseIrb(
        bytes.subarray(photoshopTag.valueOffset, photoshopTag.valueOffset + photoshopTag.nbytes)
      )
    );
  }

  return meta;
}

function readGps(
  view: DataView,
  tags: Map<number, ParsedTag>,
  little: boolean
): ImageGps | undefined {
  const latRef = readAsciiFromTag(view, tags.get(GPS_LAT_REF));
  const lonRef = readAsciiFromTag(view, tags.get(GPS_LON_REF));
  const lat = readRationalTriplet(view, tags.get(GPS_LAT), little);
  const lon = readRationalTriplet(view, tags.get(GPS_LON), little);
  if (lat === undefined || lon === undefined) return undefined;
  const latitude = applyGpsRef(lat, latRef, 'S');
  const longitude = applyGpsRef(lon, lonRef, 'W');
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  return { latitude, longitude };
}

function applyGpsRef(value: number, ref: string | undefined, negative: string): number {
  if (ref && ref.toUpperCase().startsWith(negative)) return -value;
  return value;
}

function readRationalTriplet(
  view: DataView,
  tag: ParsedTag | undefined,
  little: boolean
): number | undefined {
  if (!tag || tag.type !== TYPE_RATIONAL || tag.count < 3) return undefined;
  const deg = readRational(view, tag.valueOffset, little, false);
  const min = readRational(view, tag.valueOffset + 8, little, false);
  const sec = readRational(view, tag.valueOffset + 16, little, false);
  if (deg === undefined || min === undefined || sec === undefined) return undefined;
  return deg + min / 60 + sec / 3600;
}

function readRational(
  view: DataView,
  offset: number,
  little: boolean,
  signed: boolean
): number | undefined {
  if (offset + 8 > view.byteLength) return undefined;
  const num = signed ? view.getInt32(offset, little) : view.getUint32(offset, little);
  const den = signed ? view.getInt32(offset + 4, little) : view.getUint32(offset + 4, little);
  if (den === 0) return undefined;
  return num / den;
}

function readPointer(
  view: DataView,
  tag: ParsedTag | undefined,
  little: boolean
): number | undefined {
  if (!tag) return undefined;
  return readNumberTag(view, tag, little);
}

function readNumberTag(
  view: DataView,
  tag: ParsedTag | undefined,
  little: boolean
): number | undefined {
  if (!tag || tag.count < 1) return undefined;
  if (tag.type === TYPE_SHORT) return readU16(view, tag.valueOffset, little);
  if (tag.type === TYPE_LONG || tag.type === TYPE_BYTE)
    return readU32(view, tag.valueOffset, little);
  if (tag.type === TYPE_SLONG) {
    if (tag.valueOffset + 4 > view.byteLength) return undefined;
    return view.getInt32(tag.valueOffset, little);
  }
  return undefined;
}

function readAsciiTag(bytes: Uint8Array, tag: ParsedTag | undefined): string | undefined {
  if (!tag) return undefined;
  if (tag.type !== TYPE_ASCII && tag.type !== TYPE_UNDEFINED && tag.type !== TYPE_BYTE)
    return undefined;
  return decodeBytes(bytes.subarray(tag.valueOffset, tag.valueOffset + tag.nbytes)) || undefined;
}

function readAsciiFromTag(view: DataView, tag: ParsedTag | undefined): string | undefined {
  if (!tag) return undefined;
  const length = Math.min(tag.nbytes, view.byteLength - tag.valueOffset);
  if (length <= 0) return undefined;
  const slice = new Uint8Array(view.buffer, view.byteOffset + tag.valueOffset, length);
  return decodeBytes(slice) || undefined;
}

function readU16(view: DataView, offset: number, little: boolean): number | undefined {
  if (offset < 0 || offset + 2 > view.byteLength) return undefined;
  return view.getUint16(offset, little);
}

function readU32(view: DataView, offset: number, little: boolean): number | undefined {
  if (offset < 0 || offset + 4 > view.byteLength) return undefined;
  return view.getUint32(offset, little);
}

function parsePng(bytes: Uint8Array): ImageMetadata {
  let meta: ImageMetadata = {};
  let i = 8;
  while (i + 12 <= bytes.length) {
    const size =
      ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const dataStart = i + 8;
    if (dataStart + size + 4 > bytes.length) break;
    const data = bytes.subarray(dataStart, dataStart + size);
    if (type === 'IHDR' && data.length >= 8) {
      const width = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
      const height = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
      if (width > 0 && height > 0) meta = merge(meta, { width, height });
    } else if (type === 'eXIf') {
      meta = merge(meta, parseTiffAt(data, 0));
    }
    i = dataStart + size + 4;
    if (type === 'IEND') break;
  }
  return meta;
}

function parseWebp(bytes: Uint8Array): ImageMetadata {
  let meta: ImageMetadata = {};
  let i = 12;
  while (i + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const size = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
    const dataStart = i + 8;
    if (dataStart + size > bytes.length) break;
    const data = bytes.subarray(dataStart, dataStart + size);
    if (fourcc === 'EXIF') {
      meta = merge(meta, parseTiffAt(data, 0));
    }
    i = dataStart + size + (size % 2);
  }
  return meta;
}

export function formatExifDate(value: string): string {
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return value;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
}

export function formatGps(gps: ImageGps): string {
  return `${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}`;
}
