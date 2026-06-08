import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import plaintext from 'highlight.js/lib/languages/plaintext';

type LanguageResolverArgs = {
  ext?: string | null;
  mime?: string | null;
};

const REGISTERED_LANGUAGES: Array<[string, LanguageFn]> = [
  ['bash', bash],
  ['c', c],
  ['cpp', cpp],
  ['csharp', csharp],
  ['css', css],
  ['go', go],
  ['ini', ini],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['kotlin', kotlin],
  ['php', php],
  ['powershell', powershell],
  ['python', python],
  ['ruby', ruby],
  ['rust', rust],
  ['scss', scss],
  ['sql', sql],
  ['swift', swift],
  ['typescript', typescript],
  ['xml', xml],
  ['yaml', yaml],
  ['plaintext', plaintext],
];

for (const [name, loader] of REGISTERED_LANGUAGES) {
  if (!hljs.getLanguage(name)) {
    hljs.registerLanguage(name, loader);
  }
}

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cfg: 'ini',
  cjs: 'javascript',
  conf: 'ini',
  cpp: 'cpp',
  csharp: 'csharp',
  cs: 'csharp',
  cxx: 'cpp',
  go: 'go',
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',
  htm: 'xml',
  html: 'xml',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  css: 'css',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  lock: 'json',
  log: 'plaintext',
  mjs: 'javascript',
  php: 'php',
  ps1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  pyw: 'python',
  rb: 'ruby',
  rs: 'rust',
  sass: 'scss',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svg: 'xml',
  swift: 'swift',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  txt: 'plaintext',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

const MIME_LANGUAGE_MAP: Record<string, string> = {
  'application/json': 'json',
  'application/x-yaml': 'yaml',
  'application/xml': 'xml',
  'text/css': 'css',
  'text/csv': 'plaintext',
  'text/html': 'xml',
  'text/javascript': 'javascript',
  'text/markdown': 'plaintext',
  'text/plain': 'plaintext',
  'text/x-c': 'c',
  'text/x-c++': 'cpp',
  'text/x-csharp': 'csharp',
  'text/x-go': 'go',
  'text/x-java-source': 'java',
  'text/x-json': 'json',
  'text/x-kotlin': 'kotlin',
  'text/x-php': 'php',
  'text/x-python': 'python',
  'text/x-rustsrc': 'rust',
  'text/x-shellscript': 'bash',
  'text/x-sql': 'sql',
  'text/xml': 'xml',
  'text/yaml': 'yaml',
};

export function resolveHighlightLanguage({ ext, mime }: LanguageResolverArgs): string | undefined {
  if (ext) {
    const normalizedExt = ext.toLowerCase();
    if (normalizedExt in EXTENSION_LANGUAGE_MAP) {
      return EXTENSION_LANGUAGE_MAP[normalizedExt];
    }
  }

  if (mime) {
    const normalizedMime = mime.toLowerCase();
    if (normalizedMime in MIME_LANGUAGE_MAP) {
      return MIME_LANGUAGE_MAP[normalizedMime];
    }
    if (normalizedMime.startsWith('text/')) {
      return 'plaintext';
    }
  }

  return undefined;
}

export function highlightCode(source: string, language: string): string {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(source, { language }).value;
  }
  return hljs.highlightAuto(source).value;
}

export function isPlaintextLanguage(language?: string | null): boolean {
  return language === 'plaintext';
}

export { hljs };
