/**
 * The pure half of the add-server dialog. The parsing is where a typo becomes a
 * server that silently never starts, so it is pinned here rather than left to a
 * click-through.
 */
import { describe, expect, it } from 'vitest';
import { buildServerConfig, idFromName, parseEnvLines, splitArgs } from './AddServerDialog';

describe('idFromName', () => {
  it('makes an identifier, because the id is the tool-name prefix', () => {
    expect(idFromName('Weather API')).toBe('weather-api');
    expect(idFromName('  Acme  ')).toBe('acme');
    expect(idFromName('!!!')).toBe('server');
  });
});

describe('splitArgs', () => {
  it('respects quotes so a path with a space survives', () => {
    expect(splitArgs('-y @acme/weather-mcp')).toEqual(['-y', '@acme/weather-mcp']);
    expect(splitArgs('--dir "/Users/me/My Files" --v')).toEqual([
      '--dir',
      '/Users/me/My Files',
      '--v',
    ]);
    expect(splitArgs('   ')).toEqual([]);
  });
});

describe('parseEnvLines', () => {
  it('takes KEY=value per line and ignores blanks and comments', () => {
    expect(parseEnvLines('A=1\n\n# note\nB=two words\n')).toEqual({ A: '1', B: 'two words' });
  });
  it('keeps `=` inside the value', () => {
    expect(parseEnvLines('TOKEN=abc=def')).toEqual({ TOKEN: 'abc=def' });
  });
  it('drops a line with no key', () => {
    expect(parseEnvLines('=novalue\nnokey')).toEqual({});
  });
});

describe('buildServerConfig', () => {
  it('omits the optional fields rather than sending empty ones', () => {
    const cfg = buildServerConfig({
      name: 'Weather',
      command: 'npx',
      args: '',
      cwd: '',
      env: '',
    });
    expect(cfg).toEqual({ id: 'weather', name: 'Weather', command: 'npx', enabled: true });
  });

  it('carries args, cwd and env when they are given', () => {
    const cfg = buildServerConfig({
      name: 'Weather',
      command: 'npx',
      args: '-y @acme/weather-mcp',
      cwd: '/tmp/w',
      env: 'K=v',
    });
    expect(cfg.args).toEqual(['-y', '@acme/weather-mcp']);
    expect(cfg.cwd).toBe('/tmp/w');
    expect(cfg.env).toEqual({ K: 'v' });
    expect(cfg.enabled).toBe(true);
  });
});
