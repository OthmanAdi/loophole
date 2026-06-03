/**
 * Ambient module for `*.html` imports.
 *
 * esbuild is configured with `loader: { '.html': 'text' }` (see `build.ts`), so
 * `import html from './scale-lock.html'` inlines the file's contents as a string at
 * bundle time. This declaration tells TypeScript the import is a `string`, exactly as
 * Ableton's `modal-dialog` example does (`examples/modal-dialog/src/html.d.ts`).
 */
declare module '*.html' {
  const content: string;
  export default content;
}
