// Simple sort worker skeleton. Post { files, key, dir } and get back sorted array.
// Note: This is a skeleton; wire it from the UI for >5k items as needed.

export type SortMessage = {
  files: SortableFile[];
  key: string; // 'name' | 'size' | 'modified' | custom
  dir: 'asc' | 'desc';
};

type SortableFile = {
  path?: string;
  name?: string;
  size?: number;
  modified?: unknown;
  custom?: Record<string, unknown>;
  is_draft?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function parseToMs(input: unknown): number | null {
  if (input == null) return null;
  if (input instanceof Date) {
    const t = input.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    const ms = input < 1_000_000_000_000 ? input * 1000 : input;
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      const ms = n < 1_000_000_000_000 ? n * 1000 : n;
      return Number.isFinite(ms) ? ms : null;
    }
    let candidate = s;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
      candidate = s.replace(' ', 'T');
    }
    const t = Date.parse(candidate);
    if (Number.isFinite(t)) return t;
    if (/T\d{2}:\d{2}/.test(candidate) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(candidate)) {
      const t2 = Date.parse(candidate + 'Z');
      if (Number.isFinite(t2)) return t2;
    }
  }
  if (typeof input === 'object') {
    try {
      const obj = input as Record<string, unknown>;
      if (typeof obj.ms === 'number' && Number.isFinite(obj.ms)) return obj.ms;
      if (typeof obj.millis === 'number' && Number.isFinite(obj.millis)) return obj.millis;
      const tryFromEpochFields = (o: unknown): number | null => {
        if (!isRecord(o)) return null;
        const secs = o.secs_since_epoch ?? o.secs ?? o.seconds ?? o.sec;
        const nanos = o.nanos_since_epoch ?? o.nanos ?? o.nanoseconds ?? o.nsec ?? 0;
        const s = typeof secs === 'string' ? Number(secs) : secs;
        const n = typeof nanos === 'string' ? Number(nanos) : nanos;
        if (typeof s === 'number' && Number.isFinite(s)) {
          const ms = s * 1000 + (typeof n === 'number' && Number.isFinite(n) ? n / 1_000_000 : 0);
          return Number.isFinite(ms) ? ms : null;
        }
        return null;
      };
      const top = tryFromEpochFields(obj);
      if (top != null) return top;
      for (const k of Object.keys(obj)) {
        const nested = tryFromEpochFields(obj[k]);
        if (nested != null) return nested;
      }
      const str = String(obj);
      const t = Date.parse(str);
      if (Number.isFinite(t)) return t;
    } catch {}
  }
  return null;
}

self.onmessage = (ev: MessageEvent<SortMessage>) => {
  const { files, key, dir } = ev.data || ({} as SortMessage);
  if (!Array.isArray(files)) {
    globalThis.postMessage(files);
    return;
  }
  const cmp = (a: SortableFile, b: SortableFile) => {
    const ad = a?.is_draft === true;
    const bd = b?.is_draft === true;
    if (ad && !bd) return -1;
    if (!ad && bd) return 1;
    if (key === 'name') {
      const aBase = (String(a?.path || '')
        .split(/[\/\\]/)
        .pop() || '') as string;
      const bBase = (String(b?.path || '')
        .split(/[\/\\]/)
        .pop() || '') as string;
      const aName = (a?.name ?? aBase) as string;
      const bName = (b?.name ?? bBase) as string;
      return dir === 'asc' ? aName.localeCompare(bName) : bName.localeCompare(aName);
    }
    if (key === 'size') {
      const av = Number(a?.size || 0);
      const bv = Number(b?.size || 0);
      return dir === 'asc' ? av - bv : bv - av;
    }
    if (key === 'modified') {
      const am = parseToMs(a?.modified) ?? 0;
      const bm = parseToMs(b?.modified) ?? 0;
      return dir === 'asc' ? am - bm : bm - am;
    }
    const av = a.custom?.[key];
    const bv = b.custom?.[key];
    if (av !== undefined && bv !== undefined) {
      if (typeof av === 'string' && typeof bv === 'string') {
        return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      if (typeof av === 'number' && typeof bv === 'number') {
        return dir === 'asc' ? av - bv : bv - av;
      }
      if (av === null && bv !== null) {
        return dir === 'asc' ? -1 : 1;
      }
      if (av !== null && bv === null) {
        return dir === 'asc' ? 1 : -1;
      }
    }
    if (av !== undefined && bv === undefined) return dir === 'asc' ? -1 : 1;
    if (av === undefined && bv !== undefined) return dir === 'asc' ? 1 : -1;
    return 0;
  };
  const sorted = [...files].sort(cmp);
  globalThis.postMessage(sorted);
};
