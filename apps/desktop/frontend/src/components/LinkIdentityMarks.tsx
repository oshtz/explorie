import type { FileEntry } from '../store';
import { getLinkKind, isDanglingLink } from '../utils/linkIdentity';
import styles from './LinkIdentityMarks.module.css';

export function LinkIdentityMarks({
  file,
}: {
  file: Pick<FileEntry, 'is_symlink' | 'is_junction' | 'link_target' | 'has_xattrs'>;
}) {
  const kind = getLinkKind(file);
  const dangling = isDanglingLink(file);

  if (!kind && !file.has_xattrs) return null;

  return (
    <>
      {kind ? (
        <span
          className={`${styles.mark} ${styles.link}`}
          data-testid="link-kind"
          data-link-kind={kind}
          data-dangling={dangling ? 'true' : 'false'}
          aria-label={
            dangling
              ? kind === 'junction'
                ? 'Dangling junction'
                : 'Dangling symbolic link'
              : kind === 'junction'
                ? file.link_target
                  ? `Junction to ${file.link_target}`
                  : 'Junction'
                : file.link_target
                  ? `Symbolic link to ${file.link_target}`
                  : 'Symbolic link'
          }
        >
          {kind === 'junction' ? 'junction' : 'symlink'}
        </span>
      ) : null}
      {file.has_xattrs ? (
        <span
          className={`${styles.mark} ${styles.xattr}`}
          data-testid="xattr-mark"
          aria-label="Extended attributes on this item"
          title="Extended attributes on this item"
        >
          xattr
        </span>
      ) : null}
    </>
  );
}
