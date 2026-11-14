import { describe, expect, it } from 'vitest';

import { MAX_NEXT, safeNextPath } from './safe-next.js';

// Every string here is judged the way a browser would read it as a Location
// answered by this dashboard: where it would actually go.
const HERE = 'https://dash.example/api/ee/oidc/callback';

function lands(next: string): string {
  return new URL(next, HERE).origin;
}

describe('where a sign-in may land', () => {
  it('is a path of this dashboard, with its query and its fragment', () => {
    for (const path of [
      '/',
      '/s_demo',
      '/s_demo/sources?range=30d',
      '/s_demo/pages?filters=page%3D%3D%2Fpricing&pages=journeys',
      '/s_demo/people/v/v_abc-123.4#top',
    ]) {
      expect(safeNextPath(path)).toBe(path);
      expect(lands(path)).toBe('https://dash.example');
    }
  });

  // What a comparison of strings calls a path and a browser does not. Each of
  // these begins with one slash and not two, and each leaves.
  it('is never something a browser reads as another host', () => {
    for (const leaving of [
      '/\\evil.example',
      '/\t/evil.example',
      '/\r/evil.example',
      '/\n/evil.example',
      '/\\/evil.example',
      '/\t\\evil.example',
    ]) {
      expect(lands(leaving)).toBe('https://evil.example');
      expect(safeNextPath(leaving)).toBeUndefined();
    }
  });

  it('is never an address, a scheme, or two slashes', () => {
    for (const other of [
      '//evil.example/',
      'https://evil.example/',
      'javascript:alert(1)',
      'evil.example',
      '',
      ' /s_demo',
      '/s demo',
      '/s_demo\u0000',
    ]) {
      expect(safeNextPath(other)).toBeUndefined();
    }
  });

  it('is nothing when it is not a string, or is longer than a path here ever is', () => {
    for (const other of [undefined, null, 7, ['/s_demo'], { next: '/' }]) {
      expect(safeNextPath(other)).toBeUndefined();
    }
    expect(safeNextPath(`/${'a'.repeat(MAX_NEXT - 1)}`)).toBeDefined();
    expect(safeNextPath(`/${'a'.repeat(MAX_NEXT)}`)).toBeUndefined();
  });
});
