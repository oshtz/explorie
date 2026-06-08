/**
 * FinderTags component for displaying and editing macOS Finder tags
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { FinderTagColor } from '../services/finderIntegration';
import {
  getFinderTags,
  addFinderTag,
  removeFinderTag,
  parseFinderTag,
  getColorNameFromIndex,
  FINDER_TAG_CSS_COLORS,
  FINDER_TAG_COLORS,
  createFinderTagWithColor,
  areFinderTagsAvailable,
} from '../services/finderIntegration';
import { Icon } from './Icon';
import styles from './FinderTags.module.css';

interface FinderTagsProps {
  /** Path to the file or folder */
  path: string;
  /** Whether to allow editing tags */
  editable?: boolean;
  /** Callback when tags change */
  onTagsChange?: (tags: string[]) => void;
  /** Optional class name */
  className?: string;
}

interface ParsedTag {
  raw: string;
  name: string;
  colorIndex: number;
  colorName: FinderTagColor;
}

export function FinderTags({
  path,
  editable = false,
  onTagsChange,
  className = '',
}: FinderTagsProps) {
  const [tags, setTags] = useState<ParsedTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAvailable, setIsAvailable] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState<FinderTagColor>('None');
  const [error, setError] = useState<string | null>(null);

  // Check if Finder tags are available
  useEffect(() => {
    areFinderTagsAvailable()
      .then(setIsAvailable)
      .catch(() => setIsAvailable(false));
  }, []);

  // Load tags when path changes
  useEffect(() => {
    if (!isAvailable || !path) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    getFinderTags(path)
      .then((rawTags) => {
        const parsed = rawTags.map((raw) => {
          const { name, colorIndex } = parseFinderTag(raw);
          return {
            raw,
            name,
            colorIndex,
            colorName: getColorNameFromIndex(colorIndex),
          };
        });
        setTags(parsed);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setTags([]);
      })
      .finally(() => setLoading(false));
  }, [path, isAvailable]);

  const handleRemoveTag = useCallback(
    async (tag: ParsedTag) => {
      if (!editable) return;

      try {
        await removeFinderTag(path, tag.raw);
        const newTags = tags.filter((t) => t.raw !== tag.raw);
        setTags(newTags);
        onTagsChange?.(newTags.map((t) => t.raw));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [path, tags, editable, onTagsChange]
  );

  const handleAddTag = useCallback(async () => {
    if (!editable || !newTagName.trim()) return;

    try {
      const tagWithColor = createFinderTagWithColor(newTagName.trim(), newTagColor);
      await addFinderTag(path, tagWithColor);

      const newParsedTag: ParsedTag = {
        raw: tagWithColor,
        name: newTagName.trim(),
        colorIndex: FINDER_TAG_COLORS[newTagColor],
        colorName: newTagColor,
      };

      const newTags = [...tags, newParsedTag];
      setTags(newTags);
      onTagsChange?.(newTags.map((t) => t.raw));

      setNewTagName('');
      setNewTagColor('None');
      setIsAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [path, newTagName, newTagColor, tags, editable, onTagsChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAddTag();
      } else if (e.key === 'Escape') {
        setIsAdding(false);
        setNewTagName('');
        setNewTagColor('None');
      }
    },
    [handleAddTag]
  );

  // Don't render if not available
  if (!isAvailable) {
    return null;
  }

  if (loading) {
    return (
      <div className={`${styles.finderTags} ${className}`}>
        <span className={styles.loading}>Loading tags...</span>
      </div>
    );
  }

  return (
    <div className={`${styles.finderTags} ${className}`}>
      <div className={styles.tagList}>
        {tags.map((tag) => (
          <span
            key={tag.raw}
            className={styles.tag}
            style={{
              backgroundColor:
                tag.colorIndex > 0 ? FINDER_TAG_CSS_COLORS[tag.colorName] : undefined,
              color: tag.colorIndex > 0 ? '#fff' : undefined,
            }}
          >
            {tag.colorIndex > 0 && (
              <span
                className={styles.tagDot}
                style={{ backgroundColor: FINDER_TAG_CSS_COLORS[tag.colorName] }}
              />
            )}
            <span className={styles.tagName}>{tag.name}</span>
            {editable && (
              <button
                className={styles.removeButton}
                onClick={() => handleRemoveTag(tag)}
                aria-label={`Remove tag ${tag.name}`}
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </span>
        ))}

        {editable && !isAdding && (
          <button
            className={styles.addButton}
            onClick={() => setIsAdding(true)}
            aria-label="Add tag"
          >
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>

      {isAdding && (
        <div className={styles.addForm}>
          <input
            type="text"
            className={styles.tagInput}
            placeholder="Tag name..."
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <select
            className={styles.colorSelect}
            value={newTagColor}
            onChange={(e) => setNewTagColor(e.target.value as FinderTagColor)}
          >
            {Object.keys(FINDER_TAG_COLORS).map((color) => (
              <option key={color} value={color}>
                {color}
              </option>
            ))}
          </select>
          <button
            className={styles.confirmButton}
            onClick={handleAddTag}
            disabled={!newTagName.trim()}
          >
            Add
          </button>
          <button
            className={styles.cancelButton}
            onClick={() => {
              setIsAdding(false);
              setNewTagName('');
              setNewTagColor('None');
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}

export default FinderTags;
