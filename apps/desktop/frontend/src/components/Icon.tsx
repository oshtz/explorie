import React from 'react';
import { resolveIcon, type IconName } from '../icons';

type IconProps = {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
};

export function Icon({ name, size = 14, className, title }: IconProps) {
  const src = resolveIcon(name);
  const classes = ['pixelIcon', className].filter(Boolean).join(' ');
  return (
    <img
      src={src}
      alt=""
      title={title}
      width={size}
      height={size}
      className={classes}
      style={{
        imageRendering: 'pixelated',
        display: 'block',
      }}
    />
  );
}
