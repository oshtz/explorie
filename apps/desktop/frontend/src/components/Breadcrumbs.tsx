import React, { useMemo, useCallback, useState, useRef, useEffect, useLayoutEffect } from 'react';
import styles from './Breadcrumbs.module.css';
import { Icon } from './Icon';
import { buildPathStack, pathsEqual } from '../utils/path';

interface BreadcrumbsProps {
  path: string;
  onNavigate: (path: string) => void;
}

export function Breadcrumbs({ path, onNavigate }: BreadcrumbsProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(path);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const segments = useMemo(() => buildPathStack(path), [path]);

  // Update edit value when path changes externally
  useEffect(() => {
    if (!isEditing) {
      setEditValue(path);
    }
  }, [path, isEditing]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useLayoutEffect(() => {
    if (!isEditing && containerRef.current) {
      containerRef.current.scrollLeft = containerRef.current.scrollWidth;
    }
  }, [path, isEditing]);

  const handleSegmentClick = useCallback(
    (segmentPath: string) => {
      if (!pathsEqual(segmentPath, path)) {
        onNavigate(segmentPath);
      }
    },
    [path, onNavigate]
  );

  const handleContainerClick = useCallback(
    (e: React.MouseEvent) => {
      // Only enter edit mode if clicking the container background (not a segment)
      if (e.target === containerRef.current) {
        setIsEditing(true);
        setEditValue(path);
      }
    },
    [path]
  );

  const handleInputBlur = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        const trimmed = editValue.trim();
        if (trimmed && trimmed !== path) {
          onNavigate(trimmed);
        }
        setIsEditing(false);
      } else if (e.key === 'Escape') {
        setEditValue(path);
        setIsEditing(false);
      }
    },
    [editValue, path, onNavigate]
  );

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  }, []);

  if (isEditing) {
    return (
      <div className={styles.breadcrumbsContainer}>
        <input
          ref={inputRef}
          type="text"
          className={styles.pathInput}
          value={editValue}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onKeyDown={handleInputKeyDown}
        />
      </div>
    );
  }

  if (segments.length === 0) {
    return (
      <div
        className={styles.breadcrumbsContainer}
        ref={containerRef}
        onClick={handleContainerClick}
      >
        <span className={styles.emptyPath}>No path selected</span>
      </div>
    );
  }

  return (
    <div
      className={styles.breadcrumbsContainer}
      ref={containerRef}
      onClick={handleContainerClick}
      title="Click to edit path"
    >
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        const isRoot = index === 0;

        return (
          <React.Fragment key={segment.path}>
            <button
              className={`${styles.segment} ${isLast ? styles.segmentCurrent : ''} ${isRoot ? styles.segmentRoot : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                handleSegmentClick(segment.path);
              }}
              title={segment.path}
            >
              {isRoot && segment.name === '/' ? <Icon name="home" size={12} /> : segment.name}
            </button>
            {!isLast && (
              <span className={styles.separator}>
                <Icon name="chevron-right" size={10} />
              </span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export default Breadcrumbs;
