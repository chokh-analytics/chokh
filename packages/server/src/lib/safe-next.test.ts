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

  // Everything URLSearchParams leaves as it is: what the dashboard writes for
  // a query of its own, a People search with a space in it (`q=a+b`) among
  // them. Every printable character of ASCII goes in, and what comes out is a
  // path the rule takes.
  it('takes any query URLSearchParams wrote, a plus and a star included', () => {
    let printable = '';
    for (let code = 0x20; code < 0x7f; code += 1) {
      printable += String.fromCharCode(code);
    }
    const written = `/s_demo/people?${new URLSearchParams({ q: printable }).toString()}`;
    expect(written).toContain('+');
    expect(written).toContain('*');
    expect(safeNextPath(written)).toBe(written);
    expect(lands(written)).toBe('https://dash.example');
    for (const path of ['/s_demo/people?q=ana+bose', '/s_demo/pages?q=*pricing*', '/+/evil.example', '/*']) {
      expect(safeNextPath(path)).toBe(path);
      expect(lands(path)).toBe('https://dash.example');
    }
  });

  // And the other way: neither character helps a string that leaves.
  it('takes neither a plus nor a star where it would help a string leave', () => {
    for (const leaving of ['//+evil.example', '/\\+evil.example', '/\t/*evil.example', '/\n/+evil.example']) {
      expect(lands(leaving)).not.toBe('https://dash.example');
      expect(safeNextPath(leaving)).toBeUndefined();
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
