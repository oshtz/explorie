import React from 'react';
import type { FileEntry } from '../store';
import { isLink, linkTypeLabel, resolvedLinkTarget } from '../utils/links';
import { Icon } from './Icon';
import styles from './LinkBadge.module.css';

interface LinkBadgeProps {
  file: FileEntry;
  size?: number;
}

/**
 * Marks a symbolic link or Windows junction in a file listing, and names its
 * target. Renders nothing for entries that are not links.
 */
export function LinkBadge({ file, size = 10 }: LinkBadgeProps) {
  if (!isLink(file)) return null;

  const label = linkTypeLabel(file);
  const target = resolvedLinkTarget(file);
  const targetLabel = target ?? 'target unavailable';

  return (
    <span
      className={styles.linkBadge}
      role="img"
      aria-label={label}
      title={`${label} → ${targetLabel}`}
    >
      <Icon name="link" size={size} />
      <span className={styles.target} aria-label={`Target: ${targetLabel}`}>
        {targetLabel}
      </span>
    </span>
  );
}

export default LinkBadge;
