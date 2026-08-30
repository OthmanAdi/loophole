import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const webview = readFileSync(new URL('../webviews/set-janitor.html', import.meta.url), 'utf8');
const command = readFileSync(new URL('./set-janitor.command.ts', import.meta.url), 'utf8');

describe('Set Janitor command contract', () => {
  it('tells users that values share one entry and every deletion gets its own entry', () => {
    expect(webview).toContain(
      'Selected name and verified color changes share one undo entry when present.',
    );
    expect(webview).toMatch(/Each deletion\s+creates its own undo entry\./);
  });

  it('does not promise one undo entry for the complete sweep', () => {
    expect(webview).not.toMatch(/(?:whole|complete) sweep is one undo/i);
    expect(command).not.toMatch(/(?:whole|complete) sweep is one undo/i);
    expect(command).toContain('every structural deletion creates its own undo entry');
  });

  it('does not inject the incomplete reference palette into ordinary detection', () => {
    expect(command).toContain('detectIssues(readSet(bridge))');
    expect(command).not.toContain('DEFAULT_CLIP_PALETTE');
  });
});
