import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { FileEntry } from '../store';
import { Icon } from './Icon';
import { validateFileName } from '../utils/fileName';
import styles from './BatchRenameDialog.module.css';

type RenameMode = 'replace' | 'regex' | 'number' | 'case' | 'prefix-suffix' | 'datetime';
type InsertPosition = 'prefix' | 'suffix' | 'replace';
type CaseMode = 'upper' | 'lower' | 'title' | 'sentence';
type CaseApplyTo = 'name' | 'ext' | 'both';
type DateSource = 'now' | 'modified';

const INSERT_POSITIONS = ['prefix', 'suffix', 'replace'] as const;
const CASE_MODES = ['upper', 'lower', 'title', 'sentence'] as const;
const CASE_APPLY_TARGETS = ['name', 'ext', 'both'] as const;
const DATE_SOURCES = ['now', 'modified'] as const;

function isOneOf<T extends readonly string[]>(values: T, value: string): value is T[number] {
  return values.includes(value);
}

interface BatchRenameDialogProps {
  open: boolean;
  files: FileEntry[];
  onClose: () => void;
  onApply: (renames: { oldPath: string; newName: string }[]) => Promise<void>;
}

interface RenameResult {
  file: FileEntry;
  originalName: string;
  newName: string;
  hasConflict: boolean;
  hasChange: boolean;
  invalidReason?: string | null;
}

// Helper to get file name and extension
function splitNameExt(name: string): [string, string] {
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return [name, ''];
  return [name.slice(0, lastDot), name.slice(lastDot)];
}

// Helper to transform case
function transformCase(str: string, mode: CaseMode): string {
  switch (mode) {
    case 'upper':
      return str.toUpperCase();
    case 'lower':
      return str.toLowerCase();
    case 'title':
      return str.replace(/\b\w/g, (c) => c.toUpperCase());
    case 'sentence':
      return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    default:
      return str;
  }
}

// Helper to format date according to pattern
function formatDate(date: Date, format: string): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');

  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();

  return format
    .replace('YYYY', String(year))
    .replace('YY', String(year).slice(-2))
    .replace('MM', pad(month))
    .replace('M', String(month))
    .replace('DD', pad(day))
    .replace('D', String(day))
    .replace('HH', pad(hours))
    .replace('H', String(hours))
    .replace('hh', pad(hours % 12 || 12))
    .replace('h', String(hours % 12 || 12))
    .replace('mm', pad(minutes))
    .replace('m', String(minutes))
    .replace('ss', pad(seconds))
    .replace('s', String(seconds))
    .replace('A', hours >= 12 ? 'PM' : 'AM')
    .replace('a', hours >= 12 ? 'pm' : 'am');
}

// Helper to get date from file modified time or current time
function getDateForFile(file: FileEntry, source: DateSource): Date {
  if (source === 'modified' && file.modified) {
    // Handle different formats of modified time
    if (typeof file.modified === 'number') {
      return new Date(file.modified * 1000);
    }
    if (typeof file.modified === 'string') {
      return new Date(file.modified);
    }
    if (typeof file.modified === 'object' && file.modified !== null) {
      // Rust SystemTime object
      const mod = file.modified as { secs_since_epoch?: number; nanos_since_epoch?: number };
      if (mod.secs_since_epoch) {
        return new Date(mod.secs_since_epoch * 1000);
      }
    }
  }
  return new Date();
}

export function BatchRenameDialog({ open, files, onClose, onApply }: BatchRenameDialogProps) {
  const [mode, setMode] = useState<RenameMode>('replace');
  const [applying, setApplying] = useState(false);

  // Find & Replace state
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [replaceAll, setReplaceAll] = useState(true);

  // Regex state
  const [regexPattern, setRegexPattern] = useState('');
  const [regexReplace, setRegexReplace] = useState('');
  const [regexFlags, setRegexFlags] = useState('gi');

  // Sequential numbering state
  const [numberStart, setNumberStart] = useState(1);
  const [numberDigits, setNumberDigits] = useState(3);
  const [numberPosition, setNumberPosition] = useState<InsertPosition>('suffix');
  const [numberSeparator, setNumberSeparator] = useState('_');

  // Case transformation state
  const [caseMode, setCaseMode] = useState<CaseMode>('lower');
  const [caseApplyTo, setCaseApplyTo] = useState<CaseApplyTo>('name');

  // Prefix/Suffix state
  const [prefix, setPrefix] = useState('');
  const [suffix, setSuffix] = useState('');

  // Date/Time state
  const [dateFormat, setDateFormat] = useState('YYYY-MM-DD');
  const [datePosition, setDatePosition] = useState<InsertPosition>('prefix');
  const [dateSeparator, setDateSeparator] = useState('_');
  const [dateSource, setDateSource] = useState<DateSource>('now');

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setMode('replace');
      setFindText('');
      setReplaceText('');
      setReplaceAll(true);
      setRegexPattern('');
      setRegexReplace('');
      setRegexFlags('gi');
      setNumberStart(1);
      setNumberDigits(3);
      setNumberPosition('suffix');
      setNumberSeparator('_');
      setCaseMode('lower');
      setCaseApplyTo('name');
      setPrefix('');
      setSuffix('');
      setDateFormat('YYYY-MM-DD');
      setDatePosition('prefix');
      setDateSeparator('_');
      setDateSource('now');
      setApplying(false);
    }
  }, [open]);

  // Compute preview results
  const results = useMemo<RenameResult[]>(() => {
    const usedNames = new Set<string>();

    return files.map((file, index) => {
      const originalName = file.name || file.path.split(/[/\\]/).pop() || '';
      const [baseName, ext] = splitNameExt(originalName);
      let newBaseName = baseName;
      let newExt = ext;

      try {
        switch (mode) {
          case 'replace': {
            if (findText) {
              if (replaceAll) {
                newBaseName = baseName.split(findText).join(replaceText);
              } else {
                newBaseName = baseName.replace(findText, replaceText);
              }
            }
            break;
          }
          case 'regex': {
            if (regexPattern) {
              const regex = new RegExp(regexPattern, regexFlags);
              newBaseName = baseName.replace(regex, regexReplace);
            }
            break;
          }
          case 'number': {
            const num = String(numberStart + index).padStart(numberDigits, '0');
            if (numberPosition === 'prefix') {
              newBaseName = `${num}${numberSeparator}${baseName}`;
            } else if (numberPosition === 'suffix') {
              newBaseName = `${baseName}${numberSeparator}${num}`;
            } else {
              newBaseName = num;
            }
            break;
          }
          case 'case': {
            if (caseApplyTo === 'name' || caseApplyTo === 'both') {
              newBaseName = transformCase(baseName, caseMode);
            }
            if (caseApplyTo === 'ext' || caseApplyTo === 'both') {
              newExt = transformCase(ext, caseMode);
            }
            break;
          }
          case 'prefix-suffix': {
            newBaseName = `${prefix}${baseName}${suffix}`;
            break;
          }
          case 'datetime': {
            const fileDate = getDateForFile(file, dateSource);
            const dateStr = formatDate(fileDate, dateFormat);
            if (datePosition === 'prefix') {
              newBaseName = `${dateStr}${dateSeparator}${baseName}`;
            } else if (datePosition === 'suffix') {
              newBaseName = `${baseName}${dateSeparator}${dateStr}`;
            } else {
              newBaseName = dateStr;
            }
            break;
          }
        }
      } catch (e) {
        // Invalid regex or other error - keep original
        newBaseName = baseName;
      }

      const newName = newBaseName + newExt;
      const hasChange = newName !== originalName;
      const validation = hasChange ? validateFileName(newName) : { valid: true as const };
      const invalidReason = !validation.valid ? validation.reason : null;
      const hasConflict = usedNames.has(newName.toLowerCase());
      usedNames.add(newName.toLowerCase());

      return {
        file,
        originalName,
        newName,
        hasConflict,
        hasChange,
        invalidReason,
      };
    });
  }, [
    files,
    mode,
    findText,
    replaceText,
    replaceAll,
    regexPattern,
    regexReplace,
    regexFlags,
    numberStart,
    numberDigits,
    numberPosition,
    numberSeparator,
    caseMode,
    caseApplyTo,
    prefix,
    suffix,
    dateFormat,
    datePosition,
    dateSeparator,
    dateSource,
  ]);

  // Count changes and conflicts
  const changesCount = results.filter((r) => r.hasChange).length;
  const conflictsCount = results.filter((r) => r.hasConflict).length;
  const invalidCount = results.filter((r) => r.invalidReason).length;
  const canApply = changesCount > 0 && conflictsCount === 0 && invalidCount === 0 && !applying;

  const handleApply = useCallback(async () => {
    if (!canApply) return;

    setApplying(true);
    try {
      const renames = results
        .filter((r) => r.hasChange && !r.hasConflict && !r.invalidReason)
        .map((r) => ({
          oldPath: r.file.path,
          newName: r.newName,
        }));
      await onApply(renames);
      onClose();
    } catch (e) {
      console.error('Batch rename failed:', e);
    } finally {
      setApplying(false);
    }
  }, [canApply, results, onApply, onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && !applying) {
        onClose();
      }
    },
    [onClose, applying]
  );

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.dialog}>
        <div className={styles.header}>
          <h2 className={styles.title}>Batch Rename</h2>
          <span className={styles.fileCount}>{files.length} files</span>
          <button
            className={styles.closeButton}
            onClick={onClose}
            disabled={applying}
            aria-label="Close"
          >
            <Icon name="x" />
          </button>
        </div>

        <div className={styles.body}>
          {/* Mode tabs */}
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${mode === 'replace' ? styles.tabActive : ''}`}
              onClick={() => setMode('replace')}
            >
              Find & Replace
            </button>
            <button
              className={`${styles.tab} ${mode === 'regex' ? styles.tabActive : ''}`}
              onClick={() => setMode('regex')}
            >
              Regex
            </button>
            <button
              className={`${styles.tab} ${mode === 'number' ? styles.tabActive : ''}`}
              onClick={() => setMode('number')}
            >
              Numbering
            </button>
            <button
              className={`${styles.tab} ${mode === 'case' ? styles.tabActive : ''}`}
              onClick={() => setMode('case')}
            >
              Case
            </button>
            <button
              className={`${styles.tab} ${mode === 'prefix-suffix' ? styles.tabActive : ''}`}
              onClick={() => setMode('prefix-suffix')}
            >
              Prefix/Suffix
            </button>
            <button
              className={`${styles.tab} ${mode === 'datetime' ? styles.tabActive : ''}`}
              onClick={() => setMode('datetime')}
            >
              Date/Time
            </button>
          </div>

          {/* Mode-specific options */}
          <div className={styles.options}>
            {mode === 'replace' && (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Find</label>
                  <input
                    type="text"
                    className={styles.input}
                    value={findText}
                    onChange={(e) => setFindText(e.target.value)}
                    placeholder="Text to find..."
                    autoFocus
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Replace with</label>
                  <input
                    type="text"
                    className={styles.input}
                    value={replaceText}
                    onChange={(e) => setReplaceText(e.target.value)}
                    placeholder="Replacement text..."
                  />
                </div>
                <label className={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={replaceAll}
                    onChange={(e) => setReplaceAll(e.target.checked)}
                  />
                  <span>Replace all occurrences</span>
                </label>
              </>
            )}

            {mode === 'regex' && (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Pattern (regex)</label>
                  <input
                    type="text"
                    className={styles.input}
                    value={regexPattern}
                    onChange={(e) => setRegexPattern(e.target.value)}
                    placeholder="e.g., (\d+)"
                    autoFocus
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Replace with</label>
                  <input
                    type="text"
                    className={styles.input}
                    value={regexReplace}
                    onChange={(e) => setRegexReplace(e.target.value)}
                    placeholder="e.g., $1_new"
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Flags</label>
                  <input
                    type="text"
                    className={`${styles.input} ${styles.inputSmall}`}
                    value={regexFlags}
                    onChange={(e) => setRegexFlags(e.target.value)}
                    placeholder="gi"
                  />
                </div>
              </>
            )}

            {mode === 'number' && (
              <>
                <div className={styles.fieldRow}>
                  <div className={styles.field}>
                    <label className={styles.label}>Start at</label>
                    <input
                      type="number"
                      className={`${styles.input} ${styles.inputSmall}`}
                      value={numberStart}
                      onChange={(e) => setNumberStart(parseInt(e.target.value) || 1)}
                      min={0}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>Digits</label>
                    <input
                      type="number"
                      className={`${styles.input} ${styles.inputSmall}`}
                      value={numberDigits}
                      onChange={(e) => setNumberDigits(parseInt(e.target.value) || 1)}
                      min={1}
                      max={10}
                    />
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Position</label>
                  <select
                    className={styles.select}
                    value={numberPosition}
                    onChange={(e) => {
                      const { value } = e.target;
                      if (isOneOf(INSERT_POSITIONS, value)) setNumberPosition(value);
                    }}
                  >
                    <option value="prefix">Before name</option>
                    <option value="suffix">After name</option>
                    <option value="replace">Replace name</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Separator</label>
                  <input
                    type="text"
                    className={`${styles.input} ${styles.inputSmall}`}
                    value={numberSeparator}
                    onChange={(e) => setNumberSeparator(e.target.value)}
                    placeholder="_"
                  />
                </div>
              </>
            )}

            {mode === 'case' && (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Transform to</label>
                  <select
                    className={styles.select}
                    value={caseMode}
                    onChange={(e) => {
                      const { value } = e.target;
                      if (isOneOf(CASE_MODES, value)) setCaseMode(value);
                    }}
                  >
                    <option value="lower">lowercase</option>
                    <option value="upper">UPPERCASE</option>
                    <option value="title">Title Case</option>
                    <option value="sentence">Sentence case</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Apply to</label>
                  <select
                    className={styles.select}
                    value={caseApplyTo}
                    onChange={(e) => {
                      const { value } = e.target;
                      if (isOneOf(CASE_APPLY_TARGETS, value)) setCaseApplyTo(value);
                    }}
                  >
                    <option value="name">Name only</option>
                    <option value="ext">Extension only</option>
                    <option value="both">Both</option>
                  </select>
                </div>
              </>
            )}

            {mode === 'prefix-suffix' && (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Prefix</label>
                  <input
                    type="text"
                    className={styles.input}
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                    placeholder="Add before name..."
                    autoFocus
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Suffix</label>
                  <input
                    type="text"
                    className={styles.input}
                    value={suffix}
                    onChange={(e) => setSuffix(e.target.value)}
                    placeholder="Add after name..."
                  />
                </div>
              </>
            )}

            {mode === 'datetime' && (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Date source</label>
                  <select
                    className={styles.select}
                    value={dateSource}
                    onChange={(e) => {
                      const { value } = e.target;
                      if (isOneOf(DATE_SOURCES, value)) setDateSource(value);
                    }}
                  >
                    <option value="now">Current date/time</option>
                    <option value="modified">File modified date</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Format</label>
                  <select
                    className={styles.select}
                    value={dateFormat}
                    onChange={(e) => setDateFormat(e.target.value)}
                  >
                    <option value="YYYY-MM-DD">2024-01-15 (YYYY-MM-DD)</option>
                    <option value="YYYYMMDD">20240115 (YYYYMMDD)</option>
                    <option value="DD-MM-YYYY">15-01-2024 (DD-MM-YYYY)</option>
                    <option value="MM-DD-YYYY">01-15-2024 (MM-DD-YYYY)</option>
                    <option value="YYYY-MM-DD_HH-mm">2024-01-15_14-30 (with time)</option>
                    <option value="YYYYMMDD_HHmmss">20240115_143025 (compact with time)</option>
                    <option value="YYYY-MM-DD_HH-mm-ss">2024-01-15_14-30-25 (full)</option>
                  </select>
                  <input
                    type="text"
                    className={`${styles.input} ${styles.inputSmall}`}
                    value={dateFormat}
                    onChange={(e) => setDateFormat(e.target.value)}
                    placeholder="Custom format..."
                    style={{ marginTop: '4px' }}
                  />
                  <span className={styles.hint}>
                    YYYY=year, MM=month, DD=day, HH=hour, mm=min, ss=sec
                  </span>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Position</label>
                  <select
                    className={styles.select}
                    value={datePosition}
                    onChange={(e) => {
                      const { value } = e.target;
                      if (isOneOf(INSERT_POSITIONS, value)) setDatePosition(value);
                    }}
                  >
                    <option value="prefix">Before name</option>
                    <option value="suffix">After name</option>
                    <option value="replace">Replace name</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Separator</label>
                  <input
                    type="text"
                    className={`${styles.input} ${styles.inputSmall}`}
                    value={dateSeparator}
                    onChange={(e) => setDateSeparator(e.target.value)}
                    placeholder="_"
                  />
                </div>
              </>
            )}
          </div>

          {/* Preview */}
          <div className={styles.previewSection}>
            <div className={styles.previewHeader}>
              <span className={styles.previewTitle}>Preview</span>
              <span className={styles.previewStats}>
                {changesCount} changes
                {conflictsCount > 0 && (
                  <span className={styles.conflictBadge}>{conflictsCount} conflicts</span>
                )}
                {invalidCount > 0 && (
                  <span className={styles.conflictBadge}>{invalidCount} invalid</span>
                )}
              </span>
            </div>
            <div className={styles.previewList}>
              {results.slice(0, 100).map((result) => (
                <div
                  key={result.file.id}
                  className={`${styles.previewItem} ${
                    result.hasConflict || result.invalidReason ? styles.previewConflict : ''
                  } ${!result.hasChange ? styles.previewUnchanged : ''}`}
                >
                  <span className={styles.previewOriginal}>{result.originalName}</span>
                  <span className={styles.previewArrow}>-&gt;</span>
                  <span className={styles.previewNew}>
                    {result.newName}
                    {result.invalidReason && (
                      <span
                        className={styles.conflictIcon}
                        title={`Invalid name: ${result.invalidReason}`}
                      >
                        <Icon name="warning-box" />
                      </span>
                    )}
                    {result.hasConflict && (
                      <span className={styles.conflictIcon} title="Duplicate name">
                        <Icon name="warning-box" />
                      </span>
                    )}
                  </span>
                </div>
              ))}
              {results.length > 100 && (
                <div className={styles.previewMore}>... and {results.length - 100} more files</div>
              )}
            </div>
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelButton} onClick={onClose} disabled={applying}>
            Cancel
          </button>
          <button className={styles.applyButton} onClick={handleApply} disabled={!canApply}>
            {applying ? 'Renaming...' : `Rename ${changesCount} Files`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default BatchRenameDialog;
