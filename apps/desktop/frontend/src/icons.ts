// Dynamic Pixelarticons resolver for Vite
// Uses glob import against the app's local node_modules to avoid brittle names.

const svgs = import.meta.glob('../node_modules/pixelarticons/svg/*.svg', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export type IconName = string;

function findIcon(name: string): string | undefined {
  const suffix = `/${name}.svg`;
  for (const [k, v] of Object.entries(svgs)) {
    if (k.endsWith(suffix)) return v;
  }
  return undefined;
}

export function resolveIcon(name: IconName): string {
  // exact match first
  const exact = findIcon(name);
  if (exact) return exact;

  // alias map for common names we use in UI
  const aliasMap: Record<string, string> = {
    close: 'x',
    times: 'x',
    settings: 'sliders',
    more: 'dots-vertical',
    more_vertical: 'dots-vertical',
    'more-vertical': 'dots-vertical',
    sort: 'arrow-up',
    'chevron-up': 'arrow-up',
    'chevron-down': 'arrow-down',
    'chevron-left': 'arrow-left',
    'chevron-right': 'arrow-right',
    documents: 'file',
    pictures: 'image',
    videos: 'video',
    drive: 'hard-drive',
    archive: 'archive',
    unarchive: 'unarchive',
    compress: 'archive',
    extract: 'unarchive',
  };
  const alias = aliasMap[name];
  if (alias) {
    const aliased = findIcon(alias);
    if (aliased) return aliased;
  }

  // generic fallbacks to keep UI functional
  for (const cand of ['file', 'folder', 'grid', 'list', 'search']) {
    const v = findIcon(cand);
    if (v) return v;
  }
  // last resort: any available icon
  const first = Object.values(svgs)[0];
  return first || '';
}
