import React from 'react';
import styles from './SkipLinks.module.css';

interface SkipLink {
  id: string;
  label: string;
}

const defaultLinks: SkipLink[] = [
  { id: 'main-navigation', label: 'Skip to navigation' },
  { id: 'main-content', label: 'Skip to main content' },
  { id: 'file-list', label: 'Skip to file list' },
];

interface SkipLinksProps {
  links?: SkipLink[];
}

/**
 * Skip links for keyboard navigation.
 * Allows users to quickly jump to main sections of the application.
 * Hidden by default, visible when focused.
 */
export function SkipLinks({ links = defaultLinks }: SkipLinksProps) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const target = document.getElementById(id);
    if (target) {
      // Set tabindex if not already focusable
      if (!target.hasAttribute('tabindex')) {
        target.setAttribute('tabindex', '-1');
      }
      target.focus();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <nav className={styles.skipLinks} aria-label="Skip navigation">
      {links.map((link) => (
        <a
          key={link.id}
          href={`#${link.id}`}
          className={styles.skipLink}
          onClick={(e) => handleClick(e, link.id)}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}

export default SkipLinks;
