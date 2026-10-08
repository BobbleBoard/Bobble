import { describe, expect, it } from 'vitest';
import { addressToUrl, SEARCH_URL } from './address';

const q = (s: string) => `${SEARCH_URL}${encodeURIComponent(s)}`;

describe('addressToUrl — the address bar opens a page or searches', () => {
  it('searches words, never https://<words> (the user, 2026-10-08)', () => {
    expect(addressToUrl('best pizza near me')).toBe(q('best pizza near me'));
    expect(addressToUrl('cats')).toBe(q('cats'));
    expect(addressToUrl('what is 2+2?')).toBe(q('what is 2+2?'));
  });

  it('opens an address with https', () => {
    expect(addressToUrl('example.com')).toBe('https://example.com');
    expect(addressToUrl('docs.rs/serde')).toBe('https://docs.rs/serde');
    expect(addressToUrl('news.ycombinator.com/item?id=1')).toBe(
      'https://news.ycombinator.com/item?id=1',
    );
  });

  it('opens this machine and bare IPs with http, port and all', () => {
    expect(addressToUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(addressToUrl('localhost')).toBe('http://localhost');
    expect(addressToUrl('127.0.0.1:8080/api')).toBe('http://127.0.0.1:8080/api');
    expect(addressToUrl('app.localhost')).toBe('http://app.localhost');
  });

  it('passes a full URL through untouched', () => {
    expect(addressToUrl('https://example.com/a b')).toBe('https://example.com/a b');
    expect(addressToUrl('http://localhost:5173')).toBe('http://localhost:5173');
    expect(addressToUrl('about:blank')).toBe('about:blank');
    expect(addressToUrl('file:///Users/me/page.html')).toBe('file:///Users/me/page.html');
  });

  it('trims, and an empty bar goes nowhere', () => {
    expect(addressToUrl('  example.com  ')).toBe('https://example.com');
    expect(addressToUrl('   ')).toBe('');
  });

  it('a version number or a file name with a dot is not an address', () => {
    expect(addressToUrl('1.2')).toBe(q('1.2'));
  });
});
