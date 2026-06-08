import '@testing-library/jest-dom/vitest';

type CssGlobal = {
  CSS?: {
    escape?: (value: string) => string;
  };
};

const cssGlobal = globalThis as unknown as CssGlobal;

if (!cssGlobal.CSS) {
  cssGlobal.CSS = {};
}

if (!cssGlobal.CSS.escape) {
  cssGlobal.CSS.escape = (value: string) => value;
}

if (!globalThis.btoa) {
  globalThis.btoa = (value: string) => Buffer.from(value, 'binary').toString('base64');
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}
