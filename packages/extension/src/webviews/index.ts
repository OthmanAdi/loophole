/**
 * Webview plumbing shared by the five command modules: inline the per-extension HTML
 * (via esbuild's text loader), inject the per-invocation data into it, and build the
 * `data:text/html` URL that {@link Ui.showModalDialog} loads.
 *
 * Why templating: `showModalDialog(url, w, h)` has no inbound channel; the dialog can
 * only post a result back out (`close_and_send`). To show live data (the Set's scale,
 * the scene list, the detected issues), the host must bake that data INTO the page
 * before loading it. Each HTML file carries a single placeholder token (a comment
 * followed by an empty object literal, see {@link DATA_TOKEN}) where a JSON literal is
 * substituted; the page then reads it as `const LOOPHOLE = {...}`.
 *
 * This module imports no `@ableton-extensions/sdk` and no `node:` built-in; it is pure
 * string work and is therefore safe regardless of layer. It lives beside the HTML so
 * the `*.html` text imports resolve through the local {@link html.d.ts} ambient module.
 *
 * RING-3 PENDING: the exact `data:` URL handling and the postMessage round-trip are
 * verified only in real Live (the bundler inlines the HTML; the SDK loads the URL).
 */

import scaleLockHtml from './scale-lock.html';
import humanizeHtml from './humanize.html';
import gainStageHtml from './gain-stage.html';
import sessionToSongHtml from './session-to-song.html';
import setJanitorHtml from './set-janitor.html';

/** The raw HTML templates, inlined by esbuild's text loader at bundle time. */
export const TEMPLATES = {
  scaleLock: scaleLockHtml,
  humanize: humanizeHtml,
  gainStage: gainStageHtml,
  sessionToSong: sessionToSongHtml,
  setJanitor: setJanitorHtml,
} as const;

/** The token every template carries, replaced with the per-invocation JSON literal. */
const DATA_TOKEN = '/*__LOOPHOLE_DATA__*/ {}';

/**
 * Substitute `data` into a template's {@link DATA_TOKEN}, JSON-encoded so the page can
 * read it as a literal. `JSON.stringify` output is valid JS and cannot break out of the
 * surrounding script (it escapes `<`/`>` only if we ask, so we additionally neutralize
 * a literal `</script>` by escaping the slash, the one sequence that could close the
 * inline script early). Falls back to appending an assignment if the token is absent
 * (so a future template that drops the token still works).
 *
 * The JSON is inserted via a replacement FUNCTION (`() => json`), not a replacement
 * string. `String.replace` interprets `$$`, `$&`, `` $` ``, `$'` in a replacement
 * STRING even when the search is a plain string, so a Set object named e.g. `A $& B`
 * (which lands in the JSON payload) would otherwise corrupt the emitted
 * `const LOOPHOLE = {…}` and silently break the dialog. A function replacement is
 * inserted verbatim, sidestepping that entirely.
 */
export function injectData(template: string, data: unknown): string {
  const json = JSON.stringify(data ?? {}).replace(/<\/(script)/gi, '<\\/$1');
  if (template.includes(DATA_TOKEN)) {
    return template.replace(DATA_TOKEN, () => json);
  }
  // Token missing: inject a global assignment right after the opening <script>.
  return template.replace(/<script>/i, () => `<script>\nwindow.LOOPHOLE = ${json};`);
}

/**
 * Build the `data:text/html` URL {@link Ui.showModalDialog} loads, from a template and
 * the data to inject. Mirrors the official example's
 * `data:text/html,${encodeURIComponent(html)}` pattern.
 *
 * @param template one of {@link TEMPLATES}.
 * @param data the per-invocation data object templated into the page (see each module).
 * @returns a `data:text/html,...` URL safe to pass to `showModalDialog`.
 */
export function dialogUrl(template: string, data: unknown): string {
  const html = injectData(template, data);
  return `data:text/html,${encodeURIComponent(html)}`;
}
