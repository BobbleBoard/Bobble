/**
 * The pure half of the add-server dialog. The parsing is where a typo becomes a
 * server that silently never starts, so it is pinned here rather than left to a
 * click-through — and the paste intelligence is where a README block becomes a
 * form, which is the dialog's whole reason to exist.
 */
import { describe, expect, it } from 'vitest';
import {
  buildServerConfig,
  describeDetected,
  detectPaste,
  envToLines,
  idFromName,
  nameFromSource,
  nextFreeId,
  parseCommandLine,
  parseEnvLines,
  splitArgs,
} from './AddServerDialog';

describe('idFromName', () => {
  it('makes an identifier, because the id is the tool-name prefix', () => {
    expect(idFromName('Weather API')).toBe('weather-api');
    expect(idFromName('  Acme  ')).toBe('acme');
    expect(idFromName('!!!')).toBe('server');
  });
});

describe('nextFreeId', () => {
  it('keeps a free id and counts up past taken ones', () => {
    expect(nextFreeId('weather', new Set())).toBe('weather');
    expect(nextFreeId('weather', new Set(['weather']))).toBe('weather-2');
    expect(nextFreeId('weather', new Set(['weather', 'weather-2']))).toBe('weather-3');
  });
});

describe('splitArgs / parseCommandLine', () => {
  it('respects quotes so a path with a space survives', () => {
    expect(splitArgs('-y @acme/weather-mcp')).toEqual(['-y', '@acme/weather-mcp']);
    expect(splitArgs('--dir "/Users/me/My Files" --v')).toEqual([
      '--dir',
      '/Users/me/My Files',
      '--v',
    ]);
    expect(splitArgs('   ')).toEqual([]);
  });
  it('takes the first word as the executable', () => {
    expect(parseCommandLine('npx -y @acme/weather-mcp')).toEqual({
      command: 'npx',
      args: ['-y', '@acme/weather-mcp'],
    });
    expect(parseCommandLine('')).toEqual({ command: '', args: [] });
  });
});

describe('parseEnvLines / envToLines', () => {
  it('takes KEY=value per line and ignores blanks and comments', () => {
    expect(parseEnvLines('A=1\n\n# note\nB=two words\n')).toEqual({ A: '1', B: 'two words' });
  });
  it('keeps `=` inside the value', () => {
    expect(parseEnvLines('TOKEN=abc=def')).toEqual({ TOKEN: 'abc=def' });
  });
  it('drops a line with no key', () => {
    expect(parseEnvLines('=novalue\nnokey')).toEqual({});
  });
  it('round-trips through the edit form', () => {
    expect(envToLines({ A: '1', B: 'x=y' })).toBe('A=1\nB=x=y');
    expect(parseEnvLines(envToLines({ A: '1', B: 'x=y' }))).toEqual({ A: '1', B: 'x=y' });
  });
});

describe('nameFromSource', () => {
  it('reads a name out of a package, a path or a URL', () => {
    expect(nameFromSource('@modelcontextprotocol/server-memory')).toBe('Memory');
    expect(nameFromSource('@github/github-mcp-server')).toBe('Github');
    expect(nameFromSource('blender-mcp')).toBe('Blender');
    expect(nameFromSource('chrome-devtools-mcp@latest')).toBe('Chrome Devtools');
    expect(nameFromSource('/Users/user/tools/weather-mcp/index.js')).toBe('Weather');
    expect(nameFromSource('https://mcp.sentry.dev/mcp')).toBe('Sentry');
    expect(nameFromSource('npx')).toBe('Npx');
  });
});

describe('detectPaste', () => {
  it('leaves a single word alone — it is a name or a command', () => {
    expect(detectPaste('Weather')).toBeNull();
    expect(detectPaste('npx')).toBeNull();
    expect(detectPaste('')).toBeNull();
  });

  it('takes a README mcpServers block apart', () => {
    const blob = JSON.stringify({
      mcpServers: {
        'server-memory': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory'],
          env: { MEMORY_FILE_PATH: '/tmp/graph.json' },
        },
      },
    });
    expect(detectPaste(blob)).toEqual({
      kind: 'json',
      name: 'Memory',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: { MEMORY_FILE_PATH: '/tmp/graph.json' },
    });
  });

  it('takes one server object without the wrapper', () => {
    expect(detectPaste('{"command":"uvx","args":["blender-mcp"],"cwd":"/tmp"}')).toEqual({
      kind: 'json',
      command: 'uvx',
      args: ['blender-mcp'],
      cwd: '/tmp',
    });
  });

  it('turns a URL — bare or in JSON — into a local mcp-remote bridge', () => {
    expect(detectPaste('https://mcp.sentry.dev/mcp')).toEqual({
      kind: 'url',
      name: 'Sentry',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.sentry.dev/mcp'],
    });
    expect(detectPaste('{"mcpServers":{"zoom":{"url":"https://mcp.zoom.us/mcp"}}}')).toEqual({
      kind: 'json',
      name: 'Zoom',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.zoom.us/mcp'],
    });
  });

  it('reads a command line and names it after the package', () => {
    expect(detectPaste('npx -y @acme/weather-mcp --verbose')).toEqual({
      kind: 'command',
      name: 'Weather',
      command: 'npx',
      args: ['-y', '@acme/weather-mcp', '--verbose'],
    });
  });

  it('ignores JSON that is not a server', () => {
    expect(detectPaste('{"hello":"world"}')).toBeNull();
    expect(detectPaste('{not json')).toBeNull();
  });

  it('says what it saw', () => {
    const cmd = detectPaste('npx -y @acme/weather-mcp');
    const url = detectPaste('https://mcp.sentry.dev/mcp');
    expect(cmd === null ? '' : describeDetected(cmd)).toBe(
      'Detected: command line · local process · npx',
    );
    expect(url === null ? '' : describeDetected(url)).toBe(
      'Detected: remote server, reached through a local bridge',
    );
  });
});

describe('buildServerConfig', () => {
  it('omits the optional fields rather than sending empty ones', () => {
    const cfg = buildServerConfig({ name: 'Weather', command: 'npx', cwd: '', env: '' });
    expect(cfg).toEqual({ id: 'weather', name: 'Weather', command: 'npx', enabled: true });
  });

  it('splits the command line and carries cwd and env when they are given', () => {
    const cfg = buildServerConfig({
      name: 'Weather',
      command: 'npx -y @acme/weather-mcp',
      cwd: '/tmp/w',
      env: 'K=v',
    });
    expect(cfg.command).toBe('npx');
    expect(cfg.args).toEqual(['-y', '@acme/weather-mcp']);
    expect(cfg.cwd).toBe('/tmp/w');
    expect(cfg.env).toEqual({ K: 'v' });
    expect(cfg.enabled).toBe(true);
  });

  it('keeps the id, icon and switched-off tools of a server being edited', () => {
    const cfg = buildServerConfig(
      { name: 'Weather 2', command: 'node /x/index.js', cwd: '', env: '' },
      { id: 'weather', icon: '🌦', enabled: false, disabledTools: ['get_alerts'] },
    );
    expect(cfg).toEqual({
      id: 'weather',
      icon: '🌦',
      enabled: false,
      disabledTools: ['get_alerts'],
      name: 'Weather 2',
      command: 'node',
      args: ['/x/index.js'],
    });
  });
});
