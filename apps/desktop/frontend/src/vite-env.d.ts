/// <reference types="vite/client" />

// Declare CSS Modules
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Declare other asset types if needed
declare module '*.svg' {
  const src: string;
  export default src;
}

// Build-time injected app version (see vite.config.ts define)
declare const __APP_VERSION__: string;

// Build-time injected git short hash (see vite.config.ts define)
declare const __GIT_HASH__: string;
