#!/usr/bin/env node
/**
 * READ-ONLY live check of the Tailscale seam, run the way a Finder-launched
 * Bobble runs — with no terminal in its environment:
 *
 *   env -i HOME="$HOME" PATH=/usr/bin:/bin "$(command -v node)" scripts/live-check.mjs <mode>
 *
 * `src/live.test.ts` runs it under `PI_CLUSTER_LIVE=1`. It only ever READS:
 * `status`, `whois`, one `ping --c 1` — never up/down/login/set/serve, never
 * anything that changes Tailscale. It prints one JSON summary line (no keys,
 * no tokens) and exits 0; a failure prints `{"error": …}` and exits 1.
 *
 * Modes:
 *   read-tailnet  readTailnet() through the CLI (DEV-0)
 *   adapter       the adapter's chosen backend + the CLI backend side by side:
 *                 status, whois of this user's first online peer, one ping (DEV-1)
 *
 * The sources are TypeScript; Node strips the types itself. The one thing it
 * does not do is map the `./x.js` import specifiers the sources use to their
 * `.ts` files, which the resolve hook below adds.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});

const mode = process.argv[2] ?? 'read-tailnet';

/** A status, reduced to what the check asserts — nothing identifying beyond host names. */
function summarize(status) {
  return {
    state: status.state,
    available: status.available,
    reason: status.reason,
    peers: status.peers.length,
    online: status.peers.filter((p) => p.online).length,
    self: status.peers.find((p) => p.self)?.hostname,
  };
}

try {
  if (mode === 'read-tailnet') {
    const { readTailnet } = await import('../src/host.ts');
    const t0 = Date.now();
    const status = await readTailnet();
    console.log(
      JSON.stringify({
        mode,
        ms: Date.now() - t0,
        env: Object.keys(process.env),
        ...summarize(status),
      }),
    );
  } else if (mode === 'adapter') {
    const { createTailnetAdapter } = await import('../src/tailnet-backend.ts');
    const { createCliBackend, locateCli } = await import('../src/cli-backend.ts');
    const { sameUserPeers } = await import('../src/tailscale.ts');
    const adapter = createTailnetAdapter();
    const t0 = Date.now();
    const status = await adapter.status();
    const statusMs = Date.now() - t0;
    const kind = adapter.backendKind();
    const target = sameUserPeers(status).find((p) => p.online && !p.expired);
    const whois = target === undefined ? null : await adapter.whois(target.ip);
    const ping = target === undefined ? null : await adapter.ping(target.ip, { timeoutMs: 5000 });
    // The CLI backend on its own, so both paths are proven on this machine.
    const cliBin = await locateCli();
    const cli = cliBin === null ? null : createCliBackend({ bin: cliBin });
    const c0 = Date.now();
    const cliStatus = cli === null ? null : await cli.status();
    const cliMs = Date.now() - c0;
    const cliPing =
      cli === null || target === undefined ? null : await cli.ping(target.ip, { timeoutMs: 5000 });
    console.log(
      JSON.stringify({
        mode,
        backend: kind,
        statusMs,
        ...summarize(status),
        target: target?.hostname ?? null,
        whois:
          whois === null
            ? null
            : {
                found: whois.found,
                ...(whois.found
                  ? {
                      stableIdMatches: whois.stableId === target?.id,
                      userId: whois.userId,
                      tags: whois.tags,
                      shared: whois.shared,
                    }
                  : {}),
              },
        ping:
          ping === null
            ? null
            : {
                ok: ping.ok,
                ...(ping.ok
                  ? { path: ping.path, latencyMs: ping.latencyMs }
                  : { reason: ping.reason }),
              },
        cli:
          cli === null
            ? null
            : { ms: cliMs, state: cliStatus?.state, peers: cliStatus?.peers.length },
        cliPing:
          cliPing === null
            ? null
            : {
                ok: cliPing.ok,
                ...(cliPing.ok
                  ? { path: cliPing.path, latencyMs: cliPing.latencyMs }
                  : { reason: cliPing.reason }),
              },
      }),
    );
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
