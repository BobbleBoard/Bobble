# Devices via Tailscale: serving from another device

Track 5 of the 2026-09-23 push. Research only: no code was changed. Written against base commit
`c9fe7098`, with the in-flight vision wave still uncommitted in the working tree.

---

## 1. Goal

The user, verbatim:

> "connect devices securely via tailscale to allow for serving (gpu icon in the top left that
> currently serves as just inference engine could choose what device to serve from, advanced
> settings/panel configurable from a place in the settings menu called Devices showing status eg.
> Online, an IP, Disconnect ping, forget...."

Restated so it can be checked:

1. **Serving.** A Bobble on one machine can run its chat on a model loaded on another of the
   person's machines. The connection goes over Tailscale. It is private and end-to-end encrypted,
   with no port forwarding and nothing exposed publicly. The main case is a laptop using a
   desktop/GPU box. A Mac can also use another Mac.
2. **Choosing the device from the engine button.** The graphics-card glyph right of the chat title,
   in the top-left of the bar, is `EngineMenu.tsx`. It gains a **device chooser** ("Serve from").
   Once a device is chosen, the rest of the menu describes *that* device: running model, tok/s,
   Calibrate and engines.
3. **Settings → Devices.** A new settings section lists devices with a **status** (Online / Offline /
   …) and an **IP**, with **Ping**, **Disconnect** and **Forget** actions. It also has **Add device**
   and an **advanced per-device panel**.
4. **Secure.** Tailscale (WireGuard) carries the traffic. Bobble adds its own authorization between
   installs, because being on a tailnet is not enough (see §4.11).
5. **Implied by the track brief.** Generation jobs (image/video) can run on another device too. The
   design covers macOS, Linux and Windows and says what happens without Tailscale. Latency,
   streaming and prefix caching must hold up across the link.

**Out of scope for this track.** Splitting *one* model across devices (llama.cpp RPC, exo) belongs to
the roadmap's later "clustering". Training across devices is tracks 3/7. Porting engines to
Linux/Windows is track 4. This track depends on track 4 for Linux/Windows *serving* nodes (§6).

---

## 2. What exists today

### 2.1 `packages/cluster`: a discovery seam that nothing uses yet

- `packages/cluster/src/tailscale.ts` holds three things:
  - `TAILSCALE_PATHS` lists CLI locations per OS.
  - `parseTailscaleStatus()` is a defensive parser of `tailscale status --json` returning
    `{available, reason, peers: TailnetPeer[]}`.
  - `probePeer()` does a `GET http://<ip>:8765/cluster/hello` with a 1.5 s timeout.
  - Exported constants: `CLUSTER_PORT = 8765`, `CLUSTER_HELLO_PATH = '/cluster/hello'`, and the
    `PeerCapabilities` shape (version, ramGB, cpuCount, chip, accelerator, models).
- `packages/cluster/src/host.ts` has two functions:
  - `readTailnet()` runs `status --json` against each candidate binary.
  - `describeHost()` reports hostname/platform/arch/RAM/cores/accelerator using Node `os`.
- Tests are in `tailscale.test.ts`, using a real redacted capture (`tailscale-status.fixture.json`).
  Commit `43f62392` (2026-08-26) wrote it "so the sessions on the other boxes start from something
  real".
- **Nothing imports it.** `grep @pi-desktop/cluster` over apps/packages finds no consumer. No process
  listens on 8765 and nothing answers `/cluster/hello`.

**Defects found while reading it.** They are latent today because nothing calls this code, but
they must be fixed first:

1. **`readTailnet` can open Tailscale's GUI or fail when Bobble was launched from Finder.** On
   macOS the CLI *is* the app binary (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`; this
   Mac's `/usr/local/bin/tailscale` is a 73-byte `exec` shim to it). Per the
   [Tailscale CLI docs (macOS tab)](https://tailscale.com/docs/reference/tailscale-cli?tab=macos),
   the binary chooses GUI or CLI mode from environment variables (`SHLVL`, `TERM`, `TERM_PROGRAM`,
   `PS1`). The docs say to set `TAILSCALE_BE_CLI=1` to force CLI mode. `host.ts` spawns it with no
   env override. That works under vitest from a terminal, which is how it was "verified live". A
   Finder-launched Bobble has none of those variables. Fix: pass
   `env: {...process.env, TAILSCALE_BE_CLI: '1'}`.
2. **The Windows paths are mis-escaped.** The source literal
   `'C\\:\\\\Program Files\\\\Tailscale\\\\tailscale.exe'` evaluates to
   `C\:\\Program Files\\Tailscale\\tailscale.exe`, which is not a valid path. The test only checks
   `.includes('.exe')`. The PATH fallback `tailscale.exe` masks the problem.
3. **The parser drops fields the Devices UI needs:**
   - `DNSName`, `CurAddr` (non-empty means a direct path), `Relay` (home DERP region), `Active`,
     `LastSeen`, `Expired`/`KeyExpiry`, `UserID`, `Tags`, `ShareeNode`,
     `CurrentTailnet.{Name,MagicDNSSuffix}`.
   - **Online peers report `LastSeen: "0001-01-01T00:00:00Z"`** (measured, §2.6). That must be read
     as "absent", not as a date.
4. **`probePeer` expects `/cluster/hello` to report hardware and the model inventory.**
   Unauthenticated, that leaks to any tailnet peer. The hello must be minimal (§4.3).
5. **Discovery would probe every peer.** On a company or family tailnet that is a port scan of other
   people's machines. The default must be same-user peers only (§4.4).

### 2.2 How pi reaches a model today (the seam remote serving must fit)

- The **inference supervisor**, `apps/desktop/electron/inference/supervisor-entry.ts`, is a
  `utilityProcess` forked by `llm-main.ts:ensureChild()`. It owns the single `current: CurrentServer`
  (declared at `:363`), including its `supervisor: LlamaServerSupervisor` child process, `baseUrl`,
  `provider: 'llamacpp' | 'mlx'`, `servedModelId`, `contextWindow` and `visionReady`.
  - `status()` (`:508`) builds `LlmStatus` from `current`.
  - `emitStatus()` (`:552`) posts it to main.
  - Servers bind `127.0.0.1` on a free port (`packages/inference/src/supervisor.ts:343,467`).
- **models.json.** On every launch the supervisor calls `writeModelsJson(~/.pi/agent/models.json,
  'llamacpp' | 'mlx', block)`. The llama.cpp block uses `buildProviderBlock(..., {baseUrl,
  servedModelId, launchedContextWindow})` (`:2997`); the MLX/external-engine block uses
  `buildMlxProviderBlock` (`:1218`, `:1859`). The builders are in
  `packages/inference/src/models-json.ts`. The `api` value binds the block to our providers:
  `llamacpp-stream` goes to `packages/provider-llamacpp` (tool-call repair, TPS from `timings`, raw
  `/completion` prime/resume); `mlx-stream` goes to `packages/provider-mlx` (a generic
  OpenAI-compatible path with client-side TPS).
- **Pointing pi at the server.** `apps/desktop/src/state/local-model.ts:activateLocalModel()` (`:89`)
  starts the server, then `repointPiAtRunningServer()` (`:160`) respawns pi *on the same session
  file*. pi caches models.json at spawn. It then calls `set_model(status.provider, …)`. The callers
  are `chat/auto-router.ts` (Auto/tier/pin routing), `models/ModelsView.tsx` and the vision relaunch.
- **Every other consumer reads the same endpoint.** `llm-main.ts:getInferenceUtility()` (`:239`)
  returns `{lastStatus.baseUrl, servedModelId}` and writes it to `userData/utility-endpoint.json`.
  `pi-main.ts:buildPiEnv()` (`:155`) exports it as `PI_DESKTOP_UTILITY_BASE_URL`/`_MODEL`/`_FILE`.
  The harness fixer, reviewer, titler and **system-prompt warm-up**, the composer prefill
  (`pi/prefill-main.ts`), resume (`pi/resume-main.ts`) and corp (`ensureCorpInferenceServer`) all go
  there. **So one endpoint switch reaches every caller.**
- **Latent provider bug that matters for any authenticated endpoint.** pi 0.68.1 builds models.json
  models with `headers: undefined` (`pi-coding-agent/dist/core/model-registry.js` ≈`:392-420`). It
  delivers provider/model `headers`, `apiKey` and `authHeader: true` (→ `Authorization: Bearer`)
  through `options.headers` / `options.apiKey` (`dist/core/sdk.js` ≈`:180-190`). But
  `provider-llamacpp/src/stream.ts:677` and `provider-mlx/src/stream.ts:312` send only
  `...(model.headers ?? {})`. **Any header or key written to models.json for our APIs is silently
  dropped.** The recommended design does not need the fix (the relay adds auth, §4.6), but it is a
  real bug and is packaged as DEV-2.
- **Prefix/KV state is tied to "the one server".** `packages/harness/src/index.ts:868`
  `residentPrefix` (on `Symbol.for`, per pi process) remembers what the server holds, and the
  warm-up skips if `warmedKey` matches. That is only safe because a server change always respawns
  pi. A device change must follow the same rule (§4.6.3).

### 2.3 UI surfaces this track changes

- `apps/desktop/src/chat/EngineMenu.tsx` is "THE ENGINE MENU", with `<Glyph name="engine">`
  ("the graphics card (the user's pick)"), mounted in `ChatApp.tsx:724`. Its sections are Calibrate +
  rows, the running model + tok/s (`ThroughputLine`), `VisionRow` (`:486`) and "Available on this
  machine" engine rows. Today it is entirely local.
- `apps/desktop/src/settings/SettingsView.tsx` defines the `SettingsSection` union (`:38`), `NAV`,
  `TITLES` and `SectionBody`. The panels are in `settings/panels/*`, built from `parts.tsx`
  (`SettingSection`, `SettingRow`, `SettingGroup`). There is no Devices section.
- `chat/TopBarStatus.tsx` shows the "Loading model / Getting ready" pill. `QuickMenuPanel.tsx` and
  `TierPickerMenu.tsx` are the model pickers.
- Settings contract: `apps/desktop/electron/settings/settings-contract.ts` (`DesktopSettings` +
  `DesktopSettingsPatch`), validated in `settings-logic.ts`, persisted to `~/.pi/desktop/settings.json`.
- IPC: per-feature `*-contract.ts` files (`XInvokeMap` + `X_INVOKE_CHANNELS`), aggregated in
  `electron/ipc-contract.ts`. Names must match
  `/^[a-z][a-z0-9]*(:[a-z][a-z0-9]*)?:[a-z]+(-[a-z]+)*$/` (`ipc-contract.test.ts`).
- Glyphs: `packages/ui/src/components/glyph.tsx` `GLYPHS`, a Hugeicons 24-grid set. There is no
  `devices` glyph yet. Brand marks come from `simple-icons` (memory rule: never hand-draw a logo), and
  `simple-icons@16.25.0` ships `icons/tailscale.svg` (hex `242424`, source tailscale.com/press).

### 2.4 Generation seams (for remote gen jobs)

- `packages/gen-service/src/protocol.ts` calls itself "the REMOTE-CAPABLE seam". A job is a JSON
  `GenJob`, the worker streams NDJSON `GenEvent`s, and "the transport is the only thing that changes".
- `packages/gen-service/src/comfy-supervisor.ts`: "For a REMOTE ComfyUI, skip this entirely and hand
  ComfyClient a constant `resolveOrigin`". `ComfyClient` (`comfy-client.ts:112`) only needs an
  origin.
- The chat's `generate_image` / 3D tools reach main through `electron/gen3d/gen3d-bridge.ts` (a
  Unix-socket JSON-RPC with a token). Main runs jobs in `gen/gen-manager.ts` (JobQueue + guardian
  admission, `gen/guardian-main.ts`). The chat model is parked to make room (`gen/make-room.ts` →
  `llm-main.parkChatModel`).

### 2.5 Prior art: RemotePi (`~/RemotePi`, reference only)

- `setup.sh <linux-tailscale-ip>` wrote models.json with `"baseUrl": "http://${LINUX_IP}:8080/v1"`
  (llama-server on the Linux box). Embeddings were on `:8081` and SearXNG on `:8888`. It opened the
  firewall with `ufw allow from 100.0.0.0/8 to any port 8080`.
- `extensions/auto-start.ts` probed `:8080` and started the server over SSH
  (`systemctl --user … llama-server`).
- Lessons:
  - Plain "remote OpenAI endpoint" chat works over Tailscale.
  - That setup had **no authentication**: anything on the tailnet, or any web page on a tailnet
    device, could use the server.
  - It had no model management or status beyond port probes.
  - It needed SSH keys. Bobble's node protocol replaces all of this (§4.3).

### 2.6 Measured on this Mac, 2026-09-23 (read-only; nothing opened a window)

| Fact | Value |
|---|---|
| Tailscale variant | **Standalone** (`io.tailscale.ipn.macsys`) **1.102.4**. CLI shim `/usr/local/bin/tailscale` → app binary |
| LocalAPI credentials (macsys) | `/Library/Tailscale/ipnport → 49238`; `/Library/Tailscale/sameuserproof-49238` is `root:admin 0640` (readable by admin users only) |
| `TAILSCALE_BE_CLI=1 … status --json` | **0.12 s** wall; `BackendState: Running`; `MagicDNSEnabled: true`; one user in `User` |
| Peers | `linux-MS-7E59` (linux): Online, Active, `CurAddr` set (direct), home DERP `lax`. Two "Parent's MacBook Pro" (macOS): offline since April 2026, **one `Expired: true`** |
| `tailscale ping --c 1` Mac → linux-MS-7E59 | **10, 8, 7 ms**, direct, via a **private LAN** endpoint |
| `tailscale whois --json <ip>` shape | `{CapMap, Node{StableID, ComputedName, Hostinfo, KeyExpiry, Online, User…}, UserProfile{ID, LoginName, DisplayName, ProfilePicURL}}` |
| Ports on linux-MS-7E59 | `:8765` closed (no Bobble node), `:8080` closed (RemotePi llama-server not running) |
| llama.cpp build shipped | `PINNED_LLAMACPP` is **macOS arm64 only** (`packages/inference/src/llamacpp-manifest.ts`). The Linux box cannot run a Bobble node until track 4 |

### 2.7 What is missing (the whole feature)

- A **node service**: a listener on the tailnet, a hello, pairing, a proxy to the local model server,
  remote model management and remote generation jobs.
- **Client-side remote serving**: a way for `LlmStatus` / models.json / pi to point at another
  machine, with auth, reconnection, offline handling and a device indicator.
- **Device state**: paired devices, tokens (encrypted), serving clients, and trust policy.
- **UI**: Settings → Devices, the engine-menu device chooser, pairing dialogs, the serving indicator,
  remote wording in status and pickers.
- A **Tailscale adapter**: status, whois, ping, live updates, cross-variant and cross-OS.
- **No-Tailscale path**: an install hand-off, and later an embedded connection (tsnet).

---

## 3. External research

### 3.1 The Tailscale CLI: what it gives, and at what cost

- Commands and flags, from the [CLI reference](https://tailscale.com/docs/reference/tailscale-cli):
  - `status --json|--peers|--self|--active`
  - `ip -4|-6|-1`
  - `ping --c --timeout --tsmp --icmp --peerapi --until-direct --verbose`
  - `whois --json [--proto]`
  - `serve` (tailnet-only proxy), `cert`, `wait --timeout`
  - `up|login --auth-key --advertise-tags --hostname`, `set --operator`, `file cp|get` (Taildrop)
- **Status schema** (`ipnstate.Status` / `PeerStatus`,
  [ipnstate.go](https://github.com/tailscale/tailscale/blob/main/ipn/ipnstate/ipnstate.go)):
  - Top level: `BackendState` (`NoState|NeedsLogin|NeedsMachineAuth|Stopped|Starting|Running`),
    `AuthURL`, `Self`, `Peer` (keyed by node key), `User` (profiles by UserID), `CurrentTailnet`,
    `Health`.
  - Per peer: `ID`, `HostName`, `DNSName` (FQDN with a trailing dot), `OS`, `UserID`,
    `TailscaleIPs`, `Tags`, `CurAddr` (set when the path is direct), `Relay` (DERP region),
    `PeerRelay`, `Online`, `Active`, `LastSeen` (only meaningful when offline), `KeyExpiry`,
    `Expired`, `ShareeNode`, `CapMap`, `PeerAPIURL`.
  - That is everything the Devices list needs: name, OS, IP, online, last seen, path, key expired,
    owner.
- **Ping output** (text only; no `--json`):
  - Direct path: `pong from linux-ms-7e59 (100.101.102.110) via 192.168.x.y:41641 in 8ms` (measured).
  - Relayed paths show `via DERP(nue)` or `via peer-relay(ip:port:vni:N)`
    ([connection types](https://tailscale.com/docs/reference/connection-types)).
  - The LocalAPI returns JSON instead (`PingResult`: `LatencySeconds`, `Endpoint`,
    `DERPRegionCode`, `PeerRelay`).
- **Cost.** One `status --json` spawn is 0.12 s here. That is fine for polling at 5 s while a
  Devices surface is open. For a live background view, use the LocalAPI watch (§3.3).
- **The macOS trap.** The app-bundle binary is GUI and CLI in one. Force CLI mode with
  `TAILSCALE_BE_CLI=1` ([docs](https://tailscale.com/docs/reference/tailscale-cli?tab=macos)); see
  defect 1 in §2.1.

### 3.2 macOS variants (they decide where the CLI and LocalAPI are)

[Three ways to run Tailscale on macOS](https://tailscale.com/docs/concepts/macos-variants):

- **Standalone** (System Extension, Tailscale's recommended variant; the user's): the CLI is in the app,
  with an optional "CLI integration" that installs `/usr/local/bin/tailscale`.
- **App Store** (sandboxed Network Extension): the CLI is in the app only.
- **Open-source `tailscaled`** (Homebrew; no GUI; kernel utun).

Installing the App Store and Standalone variants together breaks both, which is one more reason
Bobble must never install Tailscale itself.

### 3.3 The LocalAPI (the daemon's own HTTP API)

- **Where it is**, per
  [safesocket_darwin.go](https://github.com/tailscale/tailscale/blob/main/safesocket/safesocket_darwin.go),
  [paths.go](https://github.com/tailscale/tailscale/blob/main/paths/paths.go) and
  [client/local](https://github.com/tailscale/tailscale/blob/main/client/local/local.go):

  | Platform / variant | Location | Auth |
  |---|---|---|
  | Linux | Unix socket `/var/run/tailscale/tailscaled.sock` | Socket peer credentials (read-only for non-root; writes need root or `set --operator`, [doc](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission)) |
  | macOS open-source | `/var/run/tailscaled.socket` | Socket peer credentials |
  | macOS Standalone (macsys) | TCP `127.0.0.1:<port>`, port from the `/Library/Tailscale/ipnport` symlink | Token in `/Library/Tailscale/sameuserproof-<port>`, sent as HTTP Basic `("", token)` |
  | macOS App Store | TCP port + token from an `lsof -c IPNExtension` match on `sameuserproof-<port>-<token>` | Basic auth |
  | Windows | Named pipe `\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled` | Pipe ACL |

  Requests use host `local-tailscaled.sock` and send a `Tailscale-Cap` header. Node's
  `http.request({socketPath})` handles both Unix sockets and Windows pipes.
- **Endpoints Bobble needs:**
  - `GET /localapi/v0/status`
  - `GET /localapi/v0/whois?addr=<ip:port>`
  - `POST /localapi/v0/ping?ip=&type=disco`
  - `GET /localapi/v0/watch-ipn-bus?mask=…`, a streaming long-poll. With `NotifyInitialStatus` plus
    `PeersChanged`/`SelfChange` it gives a continuous view without polling
    ([ipn package](https://pkg.go.dev/tailscale.com/ipn)). A 60 s idle kill has been reported
    ([#21220](https://github.com/tailscale/tailscale/issues/21220)), so reconnect on close.
- **Not a stable interface.** It is namespaced `v0` and undocumented
  ([community write-up](https://dorianmonnier.fr/posts/2024-12-26-tailscale-localapi/);
  [FR #9445](https://github.com/tailscale/tailscale/issues/9445) asks for a supported way to find it).
  **Bobble should use the LocalAPI as an optimisation and keep the CLI as the fallback.**

### 3.4 Embedding a node: tsnet, libtailscale, tailscale-rs

- **tsnet** ([docs](https://tailscale.com/docs/features/tsnet),
  [pkg.go.dev, v1.102.4, published 2026-09-10, BSD-3-Clause](https://pkg.go.dev/tailscale.com/tsnet),
  [intro](https://tailscale.com/blog/tsnet-virtual-private-services)) is a whole Tailscale node inside
  a Go program. It uses a userspace TCP/IP stack (gVisor), needs no root and no system daemon, and
  coexists with a system Tailscale. It gets its own IP, MagicDNS name and optional certificate.
  - `Server` fields: `Dir`/`Store` (state), `Hostname`, `AuthKey`, `ClientSecret` (OAuth), workload
    identity, `Ephemeral`, `ControlURL` (Headscale works), `AdvertiseTags`, `Port`.
  - Methods: `Up`, `Listen`, `ListenTLS`, `ListenFunnel`, `ListenService`, `Dial`, `LocalClient()`
    (status/whois/ping), `TailscaleIPs`, `HTTPClient`.
  - **`Loopback()`** "starts routing server on loopback address", usable as a SOCKS5 proxy onto the
    tailnet and serving the LocalAPI on `/localapi` behind basic auth. That is exactly what a
    non-Go host (Electron) needs to use an embedded node.
  - Auth precedence: `AuthKey` → `TS_AUTHKEY` → `TS_AUTH_KEY` → `ClientSecret` → workload identity
    → **interactive login URL** (printed via `UserLogf`; `Status().AuthURL`).
- **libtailscale** ([repo](https://github.com/tailscale/libtailscale)) wraps tsnet as a C library
  with Python/Ruby/Swift bindings, and is still alpha. **tailscale-rs** is a Rust preview
  ([blog](https://tailscale.com/blog/tailscale-rs-rust-tsnet-library-preview)). For Electron, a
  **Go sidecar process** is simpler and crash-isolated compared with a native Node addon per Electron
  ABI.
- **Size.** Tailscale's own example of a normal `tailscaled` build is 23 MiB uncompressed
  ([small binaries](https://tailscale.com/docs/how-to/set-up-small-tailscale)). A tsnet sidecar
  should be about 20–30 MB per OS/arch; this is an estimate, to be measured in DEV-14.
- **Headless tests.** `tailscale.com/tstest/integration/testcontrol` is an in-memory control server
  ([pkg](https://pkg.go.dev/tailscale.com/tstest/integration/testcontrol)), and libtailscale ships
  a `tstestcontrol` command. Sidecar tests can run with no real tailnet.

### 3.5 Serve, HTTPS certificates, identity headers

- [`tailscale serve`](https://tailscale.com/docs/features/tailscale-serve) proxies a local port to
  the tailnet only (Funnel is the public variant). It requires the tailnet-wide HTTPS-certificate
  setting and adds `Tailscale-User-Login`/`-Name`/`-Profile-Pic` headers. These are **not populated
  for tagged devices**, and a local proxy can spoof them
  ([identity](https://tailscale.com/docs/concepts/tailscale-identity)).
- Enabling HTTPS certificates **publishes machine names and the tailnet name to public Certificate
  Transparency logs** ([HTTPS doc](https://tailscale.com/docs/how-to/set-up-https-certificates)).
  On Linux, serve configuration needs root or the operator. It is persistent daemon configuration.
- For Bobble this means: do not depend on `serve`. WireGuard already encrypts end to end, so plain
  HTTP to the peer's 100.x address is confidential. TLS would add certificate management, a privacy
  cost and an admin-console toggle, for no confidentiality gain.

### 3.6 Access control and identity: ACLs, grants, tags, auth keys, OAuth, key expiry

- Grants: `{"src":["autogroup:member"],"dst":["autogroup:self"],"ip":["tcp:8765"]}` limits a port to
  devices owned by the same user ([grant examples](https://tailscale.com/docs/reference/examples/grants)).
  This is optional hardening to document. It is not required: the default policy allows all, and
  Bobble does its own authorization.
- **App capabilities** ([doc](https://tailscale.com/docs/features/access-control/grants/grants-app-capabilities)):
  a policy can attach `example.com/cap/<name>` JSON to src→dst. Apps read it from `whois` `CapMap`,
  the LocalAPI or tsnet. Later, an org could grant `bobble.app/cap/serve` scopes centrally.
- **Tags** give a node an owner of "tagged-devices" (no human user). Personal plan: up to 50 tagged
  resources ([pricing](https://tailscale.com/pricing)).
- **Auth keys** ([doc](https://tailscale.com/docs/features/access-control/auth-keys)) are reusable,
  ephemeral or pre-approved, and are the answer for a headless server
  (`tailscale up --auth-key` or tsnet `AuthKey`). OAuth clients and workload identity mint keys for
  fleets. They are not needed for personal use.
- **Key expiry** defaults to **180 days**, per device, and can be disabled in the admin console
  ([doc](https://tailscale.com/docs/features/access-control/key-expiry)). The user's tailnet already
  shows an `Expired: true` peer, so the UI needs a "Key expired" state.

### 3.7 Paths, latency, relays, wake

- Direct (UDP P2P) is the best path. **DERP** relays through Tailscale's servers with "limited
  quality of service" and lower throughput. **Peer Relays** (≥1.86, `tailscale set
  --relay-server-port`, granted via `tailscale.com/cap/relay`) are faster than DERP
  ([doc](https://tailscale.com/docs/features/peer-relay)). Status `CurAddr`/`Relay` and ping tell
  which path is in use.
- **Wake-on-LAN cannot cross Tailscale.** WoL is Layer 2 and Tailscale is Layer 3; it needs an
  always-on helper on the LAN ([Tailscale blog](https://tailscale.com/blog/wake-on-lan-tailscale-upsnap)).
  A sleeping serving device is simply "Offline", and the UI should say so.

### 3.8 Plans, self-hosting

- **Personal plan is free**: up to 6 users, unlimited user devices, 50 tagged resources
  ([pricing](https://tailscale.com/pricing)). Extra tsnet nodes cost nothing for personal use.
- **Headscale** ([repo](https://github.com/juanfont/headscale)) is an open-source control server.
  The system client supports a custom login server
  ([doc](https://tailscale.com/docs/how-to/set-up-custom-control-server)) and tsnet has
  `ControlURL`. Bobble works unchanged on a Headscale tailnet.

### 3.9 With and without Tailscale, per OS

| OS | Tailscale state | Read status / whois / ping | Serving listener | Notes |
|---|---|---|---|---|
| macOS | Standalone (recommended) | CLI in bundle with `TAILSCALE_BE_CLI=1`, or `/usr/local/bin/tailscale`; LocalAPI via `ipnport` + `sameuserproof` (admin users) | bind the 100.x (utun) address | Measured on this Mac |
| macOS | App Store | CLI in bundle (`TAILSCALE_BE_CLI=1`); LocalAPI via lsof discovery | bind 100.x | Sandboxed extension |
| macOS | Homebrew `tailscaled` | `/opt/homebrew/bin/tailscale`; socket `/var/run/tailscaled.socket` | bind 100.x | |
| Linux | tailscaled (kernel TUN) | `/usr/bin/tailscale`; socket; status/whois work as non-root | bind 100.x on `tailscale0` | `serve` needs operator (not used) |
| Linux | `--tun=userspace-networking` (containers) | same | **cannot bind 100.x** (no interface) | Needs the embedded (tsnet) mode |
| Windows | Tailscale for Windows | `tailscale.exe` (on PATH); named pipe | bind 100.x (Wintun) | Windows Firewall inbound prompt/rule needed (scope `100.64.0.0/10`) |
| any | **not installed** | none; offer "Get Tailscale" (tailscale.com/download) | none | Phase 2: Bobble's built-in connection (tsnet): no install, no admin rights |
| any | installed, `NeedsLogin`/`Stopped`/`NeedsMachineAuth` | status says so (`AuthURL` for login) | none | UI explains and offers "Open Tailscale" / the login URL |

### 3.10 The closest prior art: LM Studio "LM Link" (Feb 2026, with Tailscale)

- Sources: [Tailscale blog, 2026-02-25](https://tailscale.com/blog/lm-link-remote-llm-access),
  [product page](https://lmstudio.ai/link), [docs](https://lmstudio.ai/docs/lmlink),
  [FAQ](https://lmstudio.ai/docs/lmlink/basics/faq),
  [preferred device](https://lmstudio.ai/docs/lmlink/basics/preferred-device),
  [add a device](https://github.com/lmstudio-ai/docs/blob/main/5_lmlink/1_basics/add-device.md) and
  the [developer note](https://github.com/lmstudio-ai/docs/blob/main/1_developer/0_core/lmlink.md).
- **What they built:**
  - It is built on **tsnet**, "entirely in userspace" and coexisting with other Tailscale use.
  - Devices log in to an LM Studio account; a backend stores the device list "solely for discovery".
  - Linked devices auto-discover each other.
  - Remote models appear **in the model loader alongside local ones, labelled by device**.
  - **`localhost:1234` transparently proxies remote models**, so every existing client just works.
  - A **per-machine "preferred device"** decides which device loads a model present on several.
  - Status reads "disconnected" when a device drops.
  - Headless servers use `lms login` + `lms link enable`.
  - Prompts, model lists and hardware info travel only inside the WireGuard link.
- **What Bobble takes:**
  - The **localhost proxy** ("remote as local", §4.6).
  - Device-labelled models in the picker.
  - A preferred / serving device.
  - A tsnet path for users without Tailscale.
- **What Bobble cannot take:** the LM Studio account and discovery backend. Bobble is offline-first
  with no servers, so it uses the person's own tailnet.

### 3.11 llama.cpp serving facts that constrain the design

From the [server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md):

- `--host` defaults to `127.0.0.1`.
- `--api-key` / `--api-key-file` exist, but **`/health`, `/v1/health` and `GET /models` stay public**.
- `--no-slots` hides `/slots`. `POST /props` is off unless `--props`.
- CORS options are documented, and the default allows any origin.
- Relevant options: `--parallel N`, `--cache-ram` (default 8192 MiB), `-sps` slot-prompt-similarity,
  and the `id_slot` request field.

Other llama.cpp facts:

- **Router mode** (2025-12-11, [HF blog](https://huggingface.co/blog/ggml-org/model-management-in-llamacpp)):
  start with no `-m`, `--models-dir`/`--models-preset`/`--models-max` (default 4). Each model runs in
  its own process, is chosen by the request's `model` field, and is evicted LRU. That is a later route
  to multi-model serving on big boxes.
- **RPC** (`rpc-server` + `--rpc host:port`, [README](https://github.com/ggml-org/llama.cpp/blob/master/tools/rpc/README.md))
  splits a model across machines. Upstream: "Never run the RPC server on an open network … fragile
  and insecure." Out of scope here.
- **exo** ([repo](https://github.com/exo-explore/exo), Apache-2.0) does MLX sharding across Apple
  devices. It is a separate runtime and out of scope.

### 3.12 Secrets at rest: Electron `safeStorage`

[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage):

- Backends: macOS Keychain, Windows DPAPI, Linux kwallet/libsecret.
- **On Linux with no secret store, `getSelectedStorageBackend()` returns `basic_text`, which is
  effectively plaintext.** The UI must say so.
- It works after `ready`. Prefer the async `encryptStringAsync`/`decryptStringAsync`.
- It needs stable code signing so the Keychain does not re-prompt on every update. Bobble already
  has a stable self-signed identity (memory: TCC + signing).
- Bobble stores no secrets this way today: `hfToken` and search keys are plaintext in settings.json.

### 3.13 What this means for Bobble

1. **Tailscale already gives most of the feature.** It provides the encrypted transport and the
   device inventory (names, OS, IPs, online, last seen, path, key expiry, owner). `whois` gives
   cryptographic peer identity for free. Bobble needs a thin adapter, with the CLI first and the
   LocalAPI where available.
2. **Tailnet membership is not authorization.** Any process or web page on a trusted device passes a
   `whois` check, and org/family tailnets contain other people. Bobble needs per-device tokens,
   bound to the Tailscale node, plus Origin/Host rejection.
3. **Remote should look local to pi.** LM Link's localhost proxy is the right shape, and Bobble
   already routes every consumer through one endpoint (`LlmStatus.baseUrl`).
4. **Users without Tailscale** get a link to install it in v1. An embedded tsnet sidecar, the LM Link
   approach, comes later, because it adds a Go toolchain, a signed binary per OS/arch and
   Local-Network-privacy prompts (§6).
5. **Linux/Windows serving nodes are blocked on track 4.** Mac↔Mac works as soon as this track lands.
   A "custom endpoint" (BYO llama-server, RemotePi style) gives the user's Linux box value immediately.

---

## 4. Design

### 4.1 Shape

```
 CLIENT (e.g. this Mac)                                          SERVING DEVICE (sharing on)
 ┌───────────────────────────────────────┐                      ┌──────────────────────────────────────┐
 │ pi · harness · providers · corp …     │                      │ cluster-node: GATEWAY                │
 │   every consumer uses LlmStatus.baseUrl│                      │   listens ONLY on its tailnet IPs    │
 │   = http://127.0.0.1:R/v1  (the relay) │   WireGuard / TS     │   :8765 (CLUSTER_PORT)               │
 │            │                           │ ───────────────────▶ │   Bearer token → paired client       │
 │ cluster-node: RELAY 127.0.0.1:R        │  100.82.x → 100.71.x │   whois(src).StableID == client's    │
 │   + Authorization: Bearer <token>      │  direct LAN ≈ 8 ms   │   no Origin, Host = own tailnet addr │
 │   keep-alive, abort, offline detection │                      │            │ /llm/* passthrough       │
 │ supervisor: `remote` slot → LlmStatus  │                      │ supervisor: llama-server 127.0.0.1   │
 │   {…, device:{id,name,path,rttMs}}     │                      │   (--parallel ≥ 2 while sharing)     │
 └───────────────────────────────────────┘                      └──────────────────────────────────────┘
```

### 4.2 Processes and responsibilities

| Piece | Where | Does |
|---|---|---|
| **Tailscale adapter** | `packages/cluster` (pure parsers + backends) | status, whois, ping, live watch. CLI backend (with `TAILSCALE_BE_CLI=1`), LocalAPI backend (per-OS table §3.3), later a tsnet backend. Chosen per machine, with fallback |
| **cluster-node** (new `utilityProcess`, bundled like `inference-supervisor`) | `apps/desktop/electron/devices/cluster-node-entry.ts` | All network I/O: the **gateway** (server), the **relay** (client), discovery probes. Stateless apart from caches. Tokens are pushed from main and held in memory. The network-facing surface stays out of main and out of the 3.2k-line supervisor |
| **devices-main** | `apps/desktop/electron/devices/devices-main.ts` | `devices.json` store (safeStorage for secrets), trust policy, pairing approvals (dialogs via renderer events), IPC, brokering gen jobs, forking cluster-node |
| **supervisor** | `supervisor-entry.ts` | New `remote` slot beside `current`. Becomes the source of `LlmStatus` for a remote device and writes models.json for it. Remote management calls go through the relay's `/cluster/*` routes, like another external engine |

### 4.3 The Bobble node protocol (v1, JSON over HTTP on `http://<tailnet-ip>:8765`)

| Route | Auth | Scope | Purpose |
|---|---|---|---|
| `GET /cluster/hello` | none | – | `{app:'bobble', protocol:1, version, id, name, os, sharing, pairing:'auto'\|'approval'\|'closed'}`. **Nothing else: no hardware, no models** |
| `POST /cluster/pair` | none (whois-gated, rate-limited) | – | Start pairing `{clientId, clientName, clientNonce}` → `{requestId, serverNonce, serverId, status}` |
| `GET /cluster/pair/:requestId` | request-bound | – | Long-poll: `approved` (+token, once) / `denied` / `expired` |
| `DELETE /cluster/pair` | bearer | – | Revoke own token (client-side Forget) |
| `GET /cluster/ping` | bearer | – | App-level RTT |
| `GET /cluster/info` | bearer | chat | Hardware (`packages/inference/src/accelerator.ts` `detectAccelerators`), engines, downloaded models, tier picks from its own `recommend()`, gen capabilities, sharing policy |
| `GET /cluster/events` | bearer, SSE | chat | Status (the `LlmStatus` subset), download/calibration progress, guardian verdicts, `model-changed`, `sharing-stopped` |
| `POST /cluster/llm/start` · `/release` | bearer | chat | Ensure a model the device *has* is up / stop using it. `409 busy_with_other_model` (§4.7) |
| `POST /cluster/llm/download` · `/calibrate` | bearer | manage | Remote library management |
| `/llm/v1/chat/completions`, `/llm/v1/models`, `/llm/completion`, `/llm/tokenize`, `/llm/detokenize`, `/llm/apply-template`, `GET /llm/slots`, `GET /llm/props`, `GET /llm/health` | bearer | chat | **Allowlisted** pass-through to the local model server: streamed, abort-propagating, body limit 64 MB. `POST /props`, slot save/restore/erase and router `/models/load` are *not* allowed |
| `POST /cluster/gen/jobs` · `POST /cluster/files` · `GET /cluster/files/:id` | bearer | generate | Generation jobs (§4.8) |

Versioning: `protocol` is an integer. The client refuses a mismatched major version with "Update
Bobble on linux-MS-7E59".

### 4.4 Discovery

- **Tailscale is the inventory.** It supplies peers and their online state. Watch via LocalAPI
  `watch-ipn-bus` where available, otherwise poll `status --json` every 5 s while a Devices surface is
  open and every 60 s otherwise.
- **Which peers get a hello probe:**
  - Only online peers **owned by the same Tailscale user** (`Peer.UserID == Self.UserID`), untagged
    and not `ShareeNode`.
  - Plus devices the person added or paired explicitly.
  - A "Show all tailnet devices" toggle lists (but does not probe) the rest.
  - This keeps an org tailnet from being port-scanned.
- **Addressing.** Connections always use the peer's stable 100.x address (IPv6 `fd7a:115c:a1e0::/48`
  as a fallback). MagicDNS can be off, or not be the OS resolver, so the `DNSName` is only displayed,
  and accepted by the gateway's `Host` check.
- **When:**
  - On a peer's online transition.
  - When the Devices panel or engine menu opens (the existing `probePeer`, 1.5 s timeout, cached
    60 s).
  - The *active* device is followed continuously: SSE `/cluster/events`, plus `/cluster/ping` every
    15 s.

### 4.5 Pairing and trust

**Flow.** Bluetooth-style numeric comparison. WireGuard already rules out a man in the middle; the
code proves the person approved *this* request.

1. The client sends `POST /cluster/pair {clientId, clientName, clientNonce}`.
2. The server runs `whois(remoteAddr)` to get `{StableID, UserProfile.ID, LoginName, Tags, shared?}`
   and rate-limits: at most 1 pending request per peer, 5 per minute, and lock-out after 5 denials.
3. Both sides compute **SAS = 6 digits of SHA-256(clientNonce‖serverNonce‖clientId‖serverId)**.
4. **Auto-approve** if `trustMyDevices` is on AND the peer's `UserProfile.ID == Self.UserID` AND it is
   untagged AND not shared-in. Otherwise the serving device shows the approval dialog with the code.
5. On approval the server mints a **256-bit random token**. It stores
   `{clientId, name, tsStableId, tsUserId, sha256(token), scopes, approvedAt}`. The client receives
   the token once and stores it with `safeStorage`, plus
   `{serverId, tsStableId, ip, dnsName, scopes}`.
6. **Every request** carries `Authorization: Bearer <token>`. The server looks up the hash with a
   constant-time compare, requires `whois(src).StableID == record.tsStableId` (cached per connection,
   60 s LRU per IP), and checks the scope.
7. Before sending a token, the client checks that `whois(serverIp).StableID` equals the ID pinned at
   pairing. An IP reused by another node never receives a token.
8. **Forget** deletes the record on its own side. From the client it is also a best-effort
   `DELETE /cluster/pair`. A revoked client gets `401 device_revoked`, and its UI says "linux-MS-7E59
   no longer trusts this device — Pair again".

**Default trust policy:**

| Caller | Default |
|---|---|
| Same Tailscale user, untagged, not shared-in | One click. Auto-approved when "Trust my devices" is on: **default on when the tailnet has one user**, otherwise off |
| Another user in the tailnet (family/company) | Approval dialog on the serving device, with the code |
| Tagged node / shared-in node | Approval dialog, labelled "server without an owner" / "shared by <user>" |
| Request with an `Origin` header, a foreign `Host`, or a non-Tailscale source address | Rejected (403), no CORS headers ever |

**Scopes:** `chat` (default), `generate` (default), `manage` (download/calibrate on that device,
default off). Each can be toggled per client on the serving side and is visible on the client side.

### 4.6 Serving from a remote device

#### 4.6.1 "Remote as local": the relay

- `cluster-node` opens `http://127.0.0.1:R` (one free port for the app's lifetime).
- It forwards:
  - `/v1/*`, `/completion`, `/tokenize`, `/detokenize`, `/apply-template`, `GET /slots`, `GET /props`
    and `/health` to the active device's `/llm/*`;
  - `/cluster/*` to the device's `/cluster/*`, for the supervisor's own management calls.
- It adds the bearer token, strips hop-by-hop headers and keeps a keep-alive pool to the device.
- It **rejects any request with an `Origin` header or a non-loopback `Host`**. That stops a web page
  in the user's own browser from borrowing the relay.
- SSE is passed through unbuffered, with no compression on responses. Optionally, request bodies over
  64 KB are gzipped on DERP paths, where JSON compresses about 5–10×; the gateway decompresses before
  forwarding.
- Timeouts:
  - connect 3 s;
  - first byte up to 10 min (a huge prefill is legitimate), with a "waiting on linux-MS-7E59" event
    after 5 s;
  - idle between chunks 120 s.
- Errors come back as JSON the provider's `cleanProviderError` surfaces:
  - `503 device_unreachable`
  - `401 device_revoked`
  - `409 device_model_changed`
  - `423 device_busy` (the remote guardian is holding)
- **Why a relay rather than pointing models.json at the remote:**
  - Every consumer keeps working unchanged (§2.2): pi's providers, the harness warm-up, titler,
    reviewer and fixer through `PI_DESKTOP_UTILITY_FILE`, `prefill-main`, `resume-main` and corp.
  - The token never enters pi's environment or models.json. The model's `bash` inherits that
    environment, so it would otherwise be readable.
  - Offline handling, metrics and failover live in one place.
  - This is exactly LM Link's `localhost:1234` design.

#### 4.6.2 The supervisor's `remote` slot

- New requests in `apps/desktop/electron/inference/protocol.ts`:
  - `{type:'use-device', device:{id,name,relayOrigin}, modelId?, quant?, launchMode?, parallel?}`
  - `{type:'release-device'}`
- `use-device` does four things:
  1. `POST relay/cluster/llm/start` → waits for the device's `ready` status. Progress is mirrored as
     "Loading Qwen3.6 27B on linux-MS-7E59 · 42%".
  2. Subscribes to `relay/cluster/events`.
  3. Stops the local `current` server unless "Keep this Mac's model loaded as a backup" is on. That
     frees the 24 GB Mac: the point of offloading.
  4. Writes models.json.
- models.json uses the **same provider keys** as today, so `repointPiAtRunningServer` needs no
  change. The key is `llamacpp` when the remote engine is llama.cpp (keeps `/completion`
  prime/resume and `timings` TPS) and `mlx` for any other engine or a BYO endpoint. The block comes
  from a new `buildRemoteProviderBlock(remoteModelInfo, {baseUrl: http://127.0.0.1:R/v1, api})` in
  `packages/inference/src/models-json.ts`. The id is the remote `servedModelId`, `contextWindow` is
  the remote's *launched* window (the lesson in `models-json.ts:61`), and `input` comes from the
  remote's vision state.
- `status()` prefers `remote` when set. `baseUrl` is the relay, and `model`, `profile`, `provider`,
  `servedModelId`, `visionReady`/`blindReason` and `metrics` are mirrored from the device.
- **New field `LlmStatus.device`:**
  `{ id, name, kind:'local'|'bobble'|'endpoint', os?, online, path?:'direct'|'derp'|'peer-relay', rttMs? }`.
  `getInferenceUtility()` needs no change: it returns the relay URL plus the remote `servedModelId`.
- **Make-room semantics.** `parkServer()` with `remote` active answers `{ok:true, bytes:0}` at once:
  there is nothing local to park. Local image generation and remote chat then never contend for the
  Mac's memory.

#### 4.6.3 pi, prefix caching, latency

- **Respawn pi on every device change.** It goes through `repointPiAtRunningServer` on the same
  session file, exactly like a model switch. Never hot-swap the relay target under a live pi. The
  per-process `residentPrefix` (`packages/harness/src/index.ts:868`) would claim a warm prefix the new
  server does not hold, the warm-up would be skipped, and the first turn would pay a cold prefill.
- **Prefix/KV reuse is unchanged.** It is server-side: llama.cpp's slot plus the 8 GB host-RAM prompt
  cache (memory note *prompt-cache-truth*) live on the serving device. The relay forwards bytes
  untouched, so turn N+1 re-reads only the new tokens, as locally.
  - After a switch, the harness warm-up primes the *remote*. On a discrete GPU the ~9.4k-token
    prefix (memory note *prompt-prefix-cost*: 11.5 s warm-up here) should drop sharply. Measure it in
    DEV-16.
  - Switching back to local re-prefills locally, unless the backup model was kept loaded.
- **Several clients on one server.** Sharing mode relaunches with `--parallel` = 1 + remote slots
  (default 2), sized by `chooseContextCap`. llama.cpp routes each conversation to the slot with the
  longest common prefix, and the prompt cache absorbs switches.
  - Predictive prefill (`pi:prefill`) is disabled when the path is relayed and RTT is over 100 ms.
    It is an optimisation that costs bandwidth there.
- **Latency.** The measured direct LAN RTT is **7–10 ms**. TTFT gains about one RTT (the connection
  is kept alive). Token streaming is about 200–400 B per SSE event, so bandwidth does not matter.
  - The **upload** matters: every OpenAI request re-sends the whole conversation. The prompt prefix
    alone is ~38 KB of text, plus history, plus screenshots (0.1–2 MB each; the provider already drops
    stale ones via `dropStaleScreenshots`).
  - On a direct LAN path that is tens of milliseconds. On DERP it can be seconds per turn. Hence the
    path label in the UI, the gzip option above, and the "relayed" warning.
- **Stop / pause / resume.**
  - Stop: the client closing the request causes the relay to abort upstream, the gateway to abort
    its fetch, and llama-server to cancel the task. Verified by `/slots` going idle (DEV-9).
  - Resume: `resume-completion` works while the remote KV is resident, and re-prefills otherwise
    (correct, just slower).
- **Failure.**
  - A device dropping (sleep, Wi-Fi roam, Tailscale stopped) is detected by the relay (connect
    failure or SSE silence over 10 s) together with Tailscale `Online:false`. The supervisor then sets
    `phase:'error'` and `device.online:false`.
  - The top bar says "linux-MS-7E59 went offline" and offers **[Use this Mac]**. If
    `deviceFallback:'local'`, the app switches automatically.
  - When the device comes back (watch event), auto-connect resumes if enabled.

### 4.7 The serving side

- **Sharing is opt-in per device.** Settings → Devices → "Share this computer's models", default
  **off**. Turning it on:
  - starts the gateway on the Tailscale addresses (`Self.TailscaleIPs`, v4 and v6; never `0.0.0.0`);
  - rebinds when Tailscale restarts;
  - shows "Waiting for Tailscale" while the addresses are gone;
  - relaunches the model server with the extra slots.
- **The owner of the serving machine comes first.**
  - Its guardian and power policy (memory notes *guardian*, *memory-guard*) admit or hold remote work
    like local work. A hold surfaces to clients as "Paused on linux-MS-7E59: the machine is busy".
  - If its own user switches model while a client uses it, a confirm reads "the user's MacBook Pro is
    using this model. Switch anyway?". Clients then get `model-changed` and can follow or leave.
  - A client's `llm/start` for a *different* model gets `409 busy_with_other_model {loaded}` if there
    was local activity in the last 10 minutes. The client offers "Use <loaded model>". If the server
    is idle, it switches.
- **Visible while serving.**
  - A top-bar notice-slot pill, "Sharing with 1 device", opens a popover listing the client, its
    model, since when, **[Disconnect]** (ends its streams) and **[Stop sharing]** (closes the listener
    in under 250 ms).
  - Every pairing, connection and revocation goes to `~/.pi/desktop/devices-audit.log`, with token
    fingerprints only.

### 4.8 Remote generation jobs (image first, then video/audio/3D)

- **Job-level remoting, not engine-level.** A Linux node generates with ComfyUI where a Mac uses
  mflux (backends differ per OS; track 4/8). So the node receives the *job* and chooses its own
  backend.
- **Flow:**
  - `POST /cluster/gen/jobs {modality, spec:{prompt, modelId?, width, height, steps?, seed?}, inputs:[fileId]}`
    returns an `application/x-ndjson` stream of `GenEvent`s (`packages/gen-service/src/protocol.ts`).
  - Outputs arrive as `{fileId, mime, bytes}` and are fetched with `GET /cluster/files/:id` into the
    client's `~/Bobble/generated/...`. The footnote names the device. The server deletes the file after
    the fetch or within 1 h.
  - The node admits jobs through its own `JobQueue` and guardian.
- **Routing.** The `generationDevices[modality]` setting (absent means this Mac) is read by
  `gen3d-bridge.handleMethod` / `gen-manager` in main. The studios get a "Run on" control; coordinate
  with track 8's editor studios. `/cluster/info.gen` lists capabilities (installed image/video/audio/3D
  models), so the chooser only offers devices that can do the job.

### 4.9 Custom endpoints ("Add a server by address")

- Any OpenAI-compatible server reachable over the tailnet or LAN: llama-server `:8080`, Ollama
  `:11434`, LM Studio `:1234`, vLLM `:8000`, Lemonade. The person gives a URL and an optional API key.
- Bobble identifies it: `GET /props` answering means llama.cpp → `llamacpp-stream`; otherwise
  `mlx-stream`, the generic path.
- It goes **through the same relay**, which adds the key. Capabilities are limited to chat (no remote
  management, calibration or gen), and the UI says so.
- A user-initiated "Look for servers on linux-MS-7E59" probes those known ports on one chosen peer.
- **This is the user's immediate path**: a hand-run llama-server on linux-MS-7E59, as RemotePi did,
  usable before track 4 makes it a full Bobble node.

### 4.10 Users without Tailscale

- **v1.** Detect with the adapter.
  - "Not installed" shows the per-OS "Get Tailscale" link (tailscale.com/download) and one sentence:
    Tailscale connects your devices privately, and Bobble never sees or relays your data.
  - "Installed but signed out/stopped" shows the state and **[Open Tailscale]**, or the `AuthURL` for
    `NeedsLogin`.
  - Bobble never installs Tailscale or changes its settings. It is a system VPN with admin rights,
    and the variants conflict.
- **Phase 2 (DEV-14): "Bobble's own connection".**
  - A bundled Go helper using **tsnet** joins the person's tailnet as its own node,
    `bobble-<hostname>`, after a one-time "Sign in with Tailscale" in the browser.
  - It needs no install and no admin rights, and coexists with a system Tailscale. This is LM Link's
    approach.
  - The helper exposes a JSON-lines control channel: up/login-URL, status, whois, ping,
    listen-forward (tailnet `:8765` → the loopback gateway), dial-forward (loopback → peer `:8765`)
    and logout. It is one more `TailnetBackend`, so everything above is unchanged.
  - State lives in `~/.cache/bobble/tailnet/`.

### 4.11 Security model

| Threat | Mitigation |
|---|---|
| LAN / café Wi-Fi neighbours reach the node | Listen only on Tailscale addresses (or inside tsnet). The gateway refuses non-tailnet sources |
| Other people's devices on the tailnet (family plan, company, node shares) | `whois` identity; a different user or a tag means approval required. Discovery probes same-user peers only. Optional ACL: `autogroup:self` for `tcp:8765` |
| A web page on a trusted device (CORS, DNS rebinding), including the user's own browser against the local relay | Bearer token held by Bobble (browsers cannot attach it); **reject any `Origin`**; `Host` must be the tailnet address/name (or loopback on the relay); never emit CORS headers |
| Token theft | Token bound to the client's Tailscale `StableID` (checked per connection); revocable per device on either side; encrypted at rest (`safeStorage`); only `sha256` kept by the server |
| Token sent to the wrong machine (IP re-assigned) | Client pins the server's `StableID` at pairing and checks `whois` before sending |
| Lost/compromised laptop still in the tailnet | Forget on the serving device revokes instantly. Tailscale admin removal and key expiry also apply |
| A compromised same-user device auto-pairs | Auto-trust is visible and switchable. Every new client is announced ("the user's MacBook Pro connected") and audited |
| Resource abuse on the serving machine | Scopes; per-client concurrency (slots); body limits; guardian admission; Stop sharing kill switch |
| State-changing model-server endpoints | Path + method allowlist (no `POST /props`, slot save/restore/erase, router `/models/load`) |
| Confidentiality | WireGuard end to end. Tailscale's coordination server sees metadata only; DERP relays see ciphertext. Bobble has no servers |
| Public exposure | Never Funnel. No `tailscale serve` by default (CT-log exposure) |
| Secrets in logs | Tokens never logged; PI_DIAG taps log bodies, not headers; audit log keeps fingerprints |

Adjacent finding, outside this track: today's **local** llama-server binds `127.0.0.1` with
llama.cpp's permissive CORS default and no key. A web page that finds the random port could use it.
The relay's Origin rule is the cure, and the same rule (or `--api-key` plus a local relay) could harden
the local server. Flagged for the user; not bundled here.

### 4.12 Settings and data

- **`settings.json`** (`DesktopSettings`, non-secret; validated in `settings-logic.ts`):
  - `inferenceDevice: string`: `'local'` (default) or a Bobble node id or endpoint id.
  - `generationDevices: Partial<Record<'image'|'video'|'audio'|'3d', string>>`: absent means local.
  - `sharing: { enabled: false, trustMyDevices: <auto>, slots: 2, scopes: {chat:true, generate:true, manage:false} }`.
  - `deviceFallback: 'ask' | 'local'` (default `'ask'`), and `keepLocalBackup: false`.
- **`~/.pi/desktop/devices.json`** (0600; written by main only):
  `{version:1, selfId, paired:[{id, tsStableId, name, os, ip, dnsName, tokenEnc, scopes, addedAt, lastSeenAt, autoConnect}], clients:[{id, name, tsStableId, tsUserId, tokenHash, scopes, approvedAt, lastUsedAt}], endpoints:[{id, name, url, keyEnc, api}]}`.
  - It is kept out of settings.json on purpose: the supervisor and others read settings.json raw
    (`persistedHfToken`), and `safeStorage` exists only in main.

### 4.13 UI

Hardware, model names and the tailnet name in these mockups are placeholders. Only the IPs, the
8 ms path and the peer states come from §2.6.

**Settings → Devices** (new `SettingsSection 'devices'`, nav label "Devices", after "Computer use".
The glyph is a Hugeicons device/sync icon added to `GLYPHS`; the Tailscale mark comes from
simple-icons, never drawn.)

```
Devices
Use models on your other computers, privately, over Tailscale.

┌───────────────────────────────────────────────────────────────────────────┐
│ [Tailscale mark]  Connected · tailnet <name> · this Mac is                │
│                   my-macbook-pro · 100.101.102.103 [copy]                │
└───────────────────────────────────────────────────────────────────────────┘

This Mac
  Share this Mac's models with my devices                 [ Off | On ]
  Who can connect        (•) My devices, automatically   ( ) Only ones I approve
  Remote chats at once   [1] [2] [4]
  Connected now          linux-MS-7E59 · Qwen3.6 27B · since 14:02   [Disconnect]

Your devices                                                   [+ Add device]
  [linux] linux-MS-7E59   ● Online · in use     100.101.102.110   direct · 8 ms
          <GPU> · <VRAM> · Qwen3.6 27B loaded                      [Ping] [⋯]
  [mac]   Mac Studio     ● Online · not paired 100.x.y.z                  [Pair]
  [mac]   Parent's MBP   ○ Offline · last seen 28 Apr   100.101.102.121       [⋯]
  [mac]   Parent's MBP   ⚠ Key expired: sign in to Tailscale on that Mac     [⋯]
  ▸ Other devices on your tailnet (2), not running Bobble

  [⋯]  Use for chat · Ping · Disconnect · Forget · Rename · Details…
```

**Tailscale card states:**

- **Not installed**: [Get Tailscale], plus (phase 2) [Use Bobble's own connection].
- **Signed out / needs approval / stopped**: the reason, with [Open Tailscale] or the sign-in link.
- **Health warnings**: `Health[]` shown on an amber line.
- **Running**: as drawn above.

**Row status, derived:**

| Label | When |
|---|---|
| Offline · last seen … | Tailscale `Online:false` |
| Key expired | `Expired:true` |
| Online · Bobble not running / not sharing | Hello fails, or `sharing:false` |
| Online · not paired → [Pair] | Hello ok, no pairing |
| Waiting for approval on X | Pairing pending |
| Online | Paired, hello ok |
| In use | This is `inferenceDevice` |
| Busy | Remote guardian hold |
| Update Bobble on X | Protocol mismatch |

**Ping** shows both layers:

- "Tailscale: direct · 8 ms · Bobble answered in 11 ms"
- "relayed via DERP (lax) · 46 ms"
- "no reply: the device may be asleep" (Tailscale cannot wake it)

**Disconnect vs Forget:**

- On the client, Disconnect stops using the device now (back to this Mac) and pauses auto-connect,
  but keeps the pairing. Forget revokes and deletes.
- On the serving side, a connected client's Disconnect ends its streams; Forget revokes its token.

**Details** (advanced sub-view, `← Devices / linux-MS-7E59`):

- Status + [Ping]
- Addresses (IP, MagicDNS name, copy)
- Bobble version and protocol, OS, accelerator and RAM/VRAM
- Paired-on date and key fingerprint, [Forget]
- Allowed: Chat / Generation / Manage models
- Use it for: Chat · Images · Video · Audio · 3D
- If it goes away: Ask / Switch to this Mac
- Keep this Mac's model loaded as a backup
- Connect automatically when it comes online
- **Test connection**: a one-token completion reporting TTFT, tok/s and prefill tok/s over the link

**Add device** sheet:

1. Install Tailscale on both devices (per-OS links), or later sign in with Bobble's own connection.
2. On the other computer, open Bobble → Settings → Devices → turn on sharing.
3. It appears here: press Pair.

The advanced part is "Add a server by address" (URL + key, §4.9). Later there is a
`bobble-node serve` line for a headless Linux box (DEV-13).

**Pairing dialogs** (the app's shared dialog anatomy, memory note *chat-follow-and-dialogs*):

- Client: "Pairing with linux-MS-7E59. Check that it shows **482 913**, then allow it there.
  [Cancel]"
- Serving device: "**my-macbook-pro** wants to use this computer's models. Signed in as user@… ·
  code **482 913**. [Deny] [Allow]", with "Always allow my devices".
- The auto-approved case is a quiet confirmation on both sides.

**Engine menu (the GPU icon).** New first section:

```
Engines                                              [Calibrate]
Qwen3.6 27B · llama.cpp · MTP · on linux-MS-7E59 · direct 8 ms
≈ 94 tok/s
── Serve from ──────────────────────────────────────────────
 ● This Mac            M5 Pro · 24 GB
 ● linux-MS-7E59        <GPU> · direct 8 ms                 ✓
 ○ Mac Studio          offline
   Manage devices…
── Vision ─ …
── Available on linux-MS-7E59 ─ (that device's engines; Calibrate runs there, needs "manage")
```

- The trigger keeps the `engine` glyph and adds a small accent dot while a remote device serves.
  `aria-label` becomes "Engines and speed — serving from linux-MS-7E59".
- Picking a device:
  1. Pauses a streaming reply, like Calibrate does today.
  2. Uses the device's loaded model. Otherwise it uses the same model id if the device has it, or
     the device's own Auto/tier pick. If a *pinned* model is missing there, it asks:
     "linux-MS-7E59 doesn't have Qwen3.5 9B. Use its Qwen3.6 27B, or download 9B there (needs
     'Manage')".
  3. Respawns pi on the same session (§4.6.3).

**Elsewhere:**

- `TopBarStatus`: "Loading Qwen3.6 27B on linux-MS-7E59…", "linux-MS-7E59 went offline [Use this
  Mac]", "Paused on linux-MS-7E59: machine busy".
- Model pickers (`QuickMenuPanel`/`TierPickerMenu`): the active device's models come first, labelled
  "On linux-MS-7E59", then "On this Mac". Choosing one switches device (LM Link's labelled models).
- `auto-router.ts`: with a remote device active, tiers come from that device's `recommend()`
  (`/cluster/info`), not this Mac's.

### 4.14 Alternatives considered and rejected

1. **models.json pointing straight at the remote, with auth headers.**
   - It needs the header fix in both providers plus ~8 other raw callers (warm-up, titler,
     prefill, resume, corp …); any one missed fails quietly in a background path. The memory notes
     are full of that class of bug.
   - The token would sit in pi's environment, where the model's `bash` can read it.
   - Offline handling would be scattered.
   - The relay is one place, and it is LM Link's proven design.
2. **`tailscale serve` + identity headers as the auth.**
   - Needs the tailnet-wide HTTPS toggle, which publishes names to CT logs.
   - Linux operator/root; mutates persistent daemon configuration.
   - No identity headers for tagged nodes, and a local proxy can spoof them.
   - Still needs a token against browsers.
3. **Expose llama-server directly with `--api-key`** (RemotePi plus a key).
   - `GET /models` and `/health` stay public; the default CORS is permissive.
   - MLX engines have no key; there is no model management, status, gen or per-device revocation.
   - No `whois` binding.
4. **Tailscale identity only (whois, no token).** Any process or web page on a trusted device
   passes. There is no per-device revocation short of removing the node.
5. **Ed25519 device keys with signed requests.** Stronger on paper, but no gain over a token inside
   WireGuard bound to the node's `StableID`, at real implementation cost. Revisit for a non-Tailscale
   LAN mode.
6. **libtailscale through Node FFI.** Alpha, and a native addon per Electron ABI. A Go sidecar is
   simpler and crash-isolated.
7. **A managed tailnet per Bobble account** (LM Link's model). Bobble has no backend or accounts,
   and offline-first is a product rule.
8. **Splitting models across devices** (llama.cpp RPC, exo). A different feature, the roadmap's
   clustering. RPC is explicitly insecure/PoC and exo is a separate MLX runtime.
9. **LAN-only mDNS discovery / ZeroTier / NetBird.** Outside the brief. The token and pairing layer
   is transport-agnostic, so a LAN mode stays possible.
10. **Hot-swapping the relay target without respawning pi.** Breaks `residentPrefix` bookkeeping
    (§4.6.3).

---

## 5. Work packages

Order: DEV-0, then DEV-1 and DEV-2 in parallel, then DEV-3 → DEV-4 → DEV-5 → DEV-6, then DEV-7 and
DEV-8 in parallel, then DEV-9. **DEV-10 can be pulled forward right after DEV-6** for an early real
demo on linux-MS-7E59. After that: DEV-11 → DEV-15 → DEV-12 → DEV-16, and finally DEV-13 and DEV-14.

Every UI package ends with a headless probe via `apps/desktop/tests/e2e/harness.mjs` `launchApp()`
(hidden window, throwaway `$HOME`, mock-pi unless stated, focus guard in `finish()`) with
before/after screenshots that are *looked at* (memory: visual verification). Every chat-path package
logs prefill/TTFT (memory: *always check prefill*).

**Test seams, honoured only with `PI_E2E=1`:**

- `PI_CLUSTER_TAILSCALE_BIN` points at a fake CLI that prints fixture JSON. Probes must never touch
  the real tailnet or open Tailscale's GUI.
- `PI_CLUSTER_FAKE` supplies fixture peers.
- `PI_CLUSTER_BIND=127.0.0.1` and `PI_CLUSTER_PORT` support two instances on one Mac.
- A whois stub for loopback peers.

---

**DEV-0: Fix and extend `packages/cluster` (S)**

- **Files:** `packages/cluster/src/host.ts`, `tailscale.ts`, `tailscale.test.ts`,
  `tailscale-status.fixture.json` (refresh from a new redacted capture).
- **Changes:**
  - `TAILSCALE_BE_CLI=1` in the spawn env.
  - Correct `win32` paths.
  - `LastSeen` zero-time read as absent.
  - Parse `DNSName`, `CurAddr`, `Relay`, `Active`, `Expired`/`KeyExpiry`, `UserID`, `Tags`,
    `ShareeNode` and `CurrentTailnet`.
  - A `sameUserPeers()` helper.
  - `PeerCapabilities` split into `Hello` (public) and `Info` (authenticated).
- **Deps:** none.
- **Acceptance:** all current tests pass; new tests for each field, the zero `LastSeen`, `Expired`,
  and the exact `win32` string; the exec stub receives `TAILSCALE_BE_CLI=1`.
- **Verify headlessly:** vitest. One opt-in live check (`PI_CLUSTER_LIVE=1`) runs `readTailnet()`
  under `env -i HOME=… PATH=/usr/bin:/bin node …` (no `TERM`, like Finder). It returns `Running`,
  and the frontmost app is unchanged before and after.

**DEV-1: Tailscale adapter: backends, whois, ping, watch (M)**

- **Files:** `packages/cluster/src/tailnet-backend.ts` (interface), `cli-backend.ts`, `localapi.ts`
  (Linux socket; macOS OSS socket; macsys `ipnport` + `sameuserproof` Basic; App Store lsof; Windows
  pipe), `ping-parse.ts`, `whois.ts`, `watch.ts`, plus fixtures and tests.
- **Deps:** DEV-0.
- **Acceptance:**
  - Chooses the LocalAPI when reachable, else the CLI, else `{available:false, reason}`.
  - Ping parses direct, DERP(xxx), peer-relay, timeout and "no reply".
  - Whois returns `{stableId, userId, loginName, tags, shared}`.
  - Watch reconnects after close, including the 60 s idle kill.
- **Verify headlessly:** vitest against fixtures and fake sockets (a Unix socket server in the
  test). Opt-in live read-only test on this Mac.

**DEV-2: Providers honour `options.headers` / `options.apiKey` (S)**

- **Files:** `packages/provider-llamacpp/src/stream.ts` (`:677`), `packages/provider-mlx/src/stream.ts`
  (`:312`), their tests.
- **Deps:** none.
- **Acceptance:** a models.json `headers` / `authHeader`+`apiKey` reaches the request; nothing
  changes when absent.
- **Verify headlessly:** unit tests with injected fetch, asserting the headers on the wire.

**DEV-3: Device store, tokens, pairing and trust logic (M)**

- **Files:** `apps/desktop/electron/devices/devices-store.ts`, `pairing.ts` (SAS, state machine,
  expiry, rate limits), `tokens.ts` (mint, sha256, constant-time compare), `trust-policy.ts`
  (same-user / tagged / shared rules), `secret-box.ts` (safeStorage async, with a Linux `basic_text`
  flag).
- **Deps:** DEV-0.
- **Acceptance:**
  - Both sides derive the same SAS.
  - Pending requests expire at 120 s.
  - Rate limits and lock-out hold.
  - The auto-trust matrix is exactly the §4.5 table.
  - `devices.json` is written atomically, 0600.
- **Verify headlessly:** vitest (safeStorage injected).

**DEV-4: `cluster-node` utility process: gateway, relay, discovery (L)**

- **Files:** `apps/desktop/electron/devices/cluster-node-entry.ts`, `gateway.ts`, `relay.ts`,
  `discovery.ts`, `node-protocol.ts`; `apps/desktop/vite.config.ts` (an isolated entry beside
  `inference-supervisor`); `devices-main.ts` (fork, push tokens, broker).
- **Deps:** DEV-1, DEV-3.
- **Acceptance:**
  - The gateway binds only the listed tailnet addresses (a test proves `0.0.0.0` is refused) and
    rebinds on change.
  - Every §4.3 route enforces auth and scope.
  - Requests are rejected for: no token (401), wrong `StableID` (403), an `Origin` present (403), a
    bad `Host` (403), a body over the limit (413), a non-allowlisted path (404).
  - SSE passes through unbuffered: each event arrives within 20 ms of emission, measured.
  - A client abort reaches the fake llama-server within 200 ms.
  - Revocation takes effect on the next request.
  - The relay adds the token and maps errors to §4.6.1 codes.
- **Verify headlessly:** vitest integration with a fake llama-server (SSE fixture) and a whois stub
  on loopback.

**DEV-5: Supervisor `remote` slot (L)**

- **Files:** `apps/desktop/electron/inference/supervisor-entry.ts` (`remote` beside `current`;
  `status()`; `parkServer`), `protocol.ts` (`use-device`/`release-device`),
  `electron/ipc-contract.ts` (`LlmStatus.device`), `packages/inference/src/models-json.ts`
  (`buildRemoteProviderBlock`), `llm-main.ts` (plumbing; `getInferenceUtility` unchanged).
- **Deps:** DEV-4.
- **Acceptance:**
  - `use-device` yields `phase:'ready'`, `baseUrl` = relay, the remote `servedModelId` and launched
    context in models.json, and the correct provider key (llamacpp vs mlx).
  - The local server is stopped unless the backup is kept.
  - Offline gives `phase:'error'` and `device.online:false`.
  - Park answers immediately.
- **Verify headlessly:** supervisor unit tests with a fake node, checking models.json content and
  status transitions.

**DEV-6: IPC, settings, renderer state (M)**

- **Files:**
  - `apps/desktop/electron/devices/devices-contract.ts`:
    - channels `devices:status|list|refresh|ping|pair|pair-cancel|approve|deny|forget|disconnect|use|kick|serve-set|add-endpoint|test`;
    - events `devices:changed|pair-request|pair-progress|serving`.
  - `electron/ipc-contract.ts` (aggregate), `preload.ts` allowlist.
  - `settings/settings-contract.ts` + `settings-logic.ts` (§4.12 keys).
  - `apps/desktop/src/state/devices-store.ts`.
  - `state/local-model.ts` (`activateModel(device, …)`), `chat/auto-router.ts` (device-aware tiers).
- **Deps:** DEV-3, DEV-4, DEV-5.
- **Acceptance:** channel-name test passes; settings patches validate and persist; the store
  reflects events.
- **Verify headlessly:** vitest (settings-logic, store reducers, channel test).

**DEV-7: Settings → Devices panel, pairing dialogs, serving pill (L)**

- **Files:** `apps/desktop/src/settings/panels/DevicesPanel.tsx` (+ `DeviceRow`, `DeviceDetails`,
  `AddDeviceSheet`, `PairDialog`, `ServingPill`), `SettingsView.tsx` (section, nav, title),
  `packages/ui/src/components/glyph.tsx` (`devices` glyph from Hugeicons), the Tailscale mark via the
  existing simple-icons path, styles.
- **Deps:** DEV-6.
- **Acceptance:** every state in §4.13 renders with the exact copy. Ping shows both layers. Forget
  and Disconnect do what §4.13 says. The approval dialog appears on the serving instance.
  Light/dark, 16 px icons, no overflow at the panel's minimum width.
- **Verify headlessly:** new `apps/desktop/tests/e2e/devices-panel-probe.mjs` with
  `PI_CLUSTER_TAILSCALE_BIN` fixtures for four Tailscale states: not installed, NeedsLogin, Stopped,
  Running (peers online/offline/expired/not-paired/paired/in-use). An in-probe fake node answers
  hello/pair. Screenshots of each state in both themes; computed styles read; focus guard.

**DEV-8: Engine menu "Serve from", status wording, pickers (M)**

- **Files:** `apps/desktop/src/chat/EngineMenu.tsx` (section, badge, head subline, remote engines,
  remote calibrate pass-through), `chat/TopBarStatus.tsx`, `chat/QuickMenuPanel.tsx`,
  `chat/TierPickerMenu.tsx`, `state/llm-store.ts`.
- **Deps:** DEV-5, DEV-6.
- **Acceptance:**
  - Selecting a device pauses a streaming reply, switches and respawns pi.
  - The badge and `aria-label` update.
  - Offline shows [Use this Mac], which works.
  - The picker groups by device.
- **Verify headlessly:** new `engine-device-probe.mjs` (mock-pi + fake node): open the menu,
  screenshot, pick the remote, assert `llm:status.device` and the badge, kill the fake node, assert
  the offline copy and recovery.

**DEV-9: Two Bobbles on one Mac, end to end (M)**

- **Files:** new `apps/desktop/tests/e2e/devices-two-instance-probe.mjs`.
- **Setup:** instance B is the server (`realCache`, the smallest downloaded chat model,
  `PI_CLUSTER_BIND=127.0.0.1`). Instance A is the client (real pi).
- **Deps:** DEV-5 through DEV-8.
- **Acceptance:**
  - Pairing with approval via B's dialog.
  - A's chat streams from B.
  - `PI_DIAG_PROMPTS` shows turns 2–3 re-reading only the new tokens on B (`cached_tokens` ≈ prompt
    − new).
  - Stop on A leaves B's `/slots` idle within 1 s.
  - B "Stop sharing" puts A into the offline state.
  - TTFT via the relay is within 30 ms of direct on loopback.
- **Verify headlessly:** the probe itself, both windows hidden, with the focus guard. Uses one small
  model; checks for orphans afterwards (memory: *orphan-servers*).

**DEV-10: Custom endpoint devices (BYO server) (M)**

- **Files:** `devices/endpoints.ts` (sniff `/props` vs `/v1/models`, per-endpoint key), the relay
  endpoint mode, the "Add a server by address" UI, "Look for servers on …" (a user-initiated
  known-port probe).
- **Deps:** DEV-4, DEV-5, DEV-6.
- **Acceptance:** a llama.cpp endpoint gets `llamacpp-stream`; an OpenAI-generic one gets
  `mlx-stream`; the key is added by the relay; capability limits are stated in the UI.
- **Verify headlessly:** vitest with fake servers; e2e with a local fake OpenAI server. Opt-in live
  check against a hand-run llama-server on linux-MS-7E59.

**DEV-11: Remote model management and the sharing policy (M)**

- **Files:** gateway `/cluster/info|llm/start|release|download|calibrate`; supervisor sharing-slots
  relaunch; `busy_with_other_model` policy; the serving-side switch confirm; remote calibration rows
  in the engine menu.
- **Deps:** DEV-5, DEV-8.
- **Acceptance:** the policy table in §4.7 holds; scopes are enforced; remote calibration rows fill
  in the client's menu.
- **Verify headlessly:** vitest (policy); an extension of DEV-9 (switch conflict, remote calibrate
  on the small model).

**DEV-12: Remote generation jobs (L)**

- **Files:** gateway `/cluster/gen/jobs` + `/cluster/files`; `electron/gen3d/gen3d-bridge.ts` and
  `gen/gen-manager.ts` routing by `generationDevices`; studio "Run on" control (with track 8); the
  make-room skip when chat is remote.
- **Deps:** DEV-4, DEV-6. Linux nodes also need track 4 gen backends.
- **Acceptance:** a 256² image generated on B lands in A's generated directory with the device
  footnote; progress streams; guardian refusal on B reaches A as a readable reason.
- **Verify headlessly:** vitest with a fake runner; the two-instance probe with a tiny image job
  (only if a small image model is on disk).

**DEV-13: Headless `bobble-node` for Linux/Windows servers (XL)**

- **Files:** new `packages/node-cli` bundling `packages/inference` (supervisor logic) and the
  gateway; a systemd `--user` unit; `bobble-node pair approve <code>`, `--trust-my-devices`,
  `--auth-key` for tsnet mode.
- **Deps:** track 4 (Linux/Windows llama.cpp in `llamacpp-manifest.ts`, hardware detection), DEV-4,
  DEV-11.
- **Acceptance:** on linux-MS-7E59, `bobble-node serve` appears as a device and serves chat.
- **Verify headlessly:** CI/container unit tests; opt-in live run on the box.

**DEV-14: Bobble's own Tailscale connection (tsnet sidecar) (XL)**

- **Files:** new `packages/tailnet-helper` (Go, tsnet v1.102.x, BSD-3); a JSON-lines control
  protocol; build per OS/arch; electron-builder `extraResources` and signing in `ship-local` (like
  pi-mac/xlsx-sidecar); a `TailnetBackend` implementation; the "Sign in with Tailscale" UI.
- **Deps:** DEV-1, DEV-4.
- **Acceptance:** with no system Tailscale, two Bobbles pair and serve. With a system Tailscale
  present, both coexist.
- **Verify headlessly:** Go tests against `tstest/integration/testcontrol`; two sidecars in CI;
  measure binary size.

**DEV-15: Security hardening and review (M)**

- **Files:** gateway/relay rate limits, audit log, per-client concurrency caps, header redaction in
  PI_DIAG taps, an ACL snippet in the Devices help text, the Stop-sharing kill-switch latency test.
- **Deps:** DEV-4.
- **Acceptance:** the §4.11 table has a test per row; the kill switch takes under 250 ms; no token
  appears in any log.
- **Verify headlessly:** a vitest security suite plus a fuzz pass on the unauthenticated routes.

**DEV-16: Cross-device acceptance on real hardware (M)**

- **Files:** `apps/desktop/tests/e2e/devices-real-probe.mjs` (opt-in).
- **Deps:** DEV-10 (BYO endpoint) now; DEV-13 later.
- **Acceptance:** a report table of TTFT, prefill tok/s, decode tok/s and per-turn
  `cached_tokens`, for local M5 against linux-MS-7E59, on the same model, direct path.
- **Verify headlessly:** a scripted, hidden run with `PI_DIAG_PROMPTS` logs attached.

---

## 6. Risks, blockers, open questions

### Blockers

1. **The Linux box cannot be a Bobble node until track 4 lands.** `PINNED_LLAMACPP` ships macOS
   arm64 only and the hardware/engine paths are Mac-first. linux-MS-7E59, his only online peer, can
   serve today only as a **custom endpoint** (DEV-10) running a hand-started llama-server, as RemotePi
   did.
2. **No second online Mac on the tailnet.** Both "Parent's MacBook Pro" nodes are offline since
   April 2026, and one key is expired. Mac↔Mac validation is two instances on this Mac (DEV-9) until
   another Mac is online.
3. **The in-flight vision wave touches the same files**: `llm-main.ts`, `supervisor-entry.ts`,
   `protocol.ts`, `EngineMenu.tsx`, `settings-contract.ts`, `ipc-contract.ts`, `stream.ts`.
   Implementation must start after that wave is committed.
4. **DEV-14 needs a Go toolchain in the build** and a per-OS/arch signed binary (notarization on
   macOS). None exists in the repo today.

### Risks

- **The macOS CLI GUI trap.** Any new spawn of the app-bundle binary without `TAILSCALE_BE_CLI=1`
  can surface Tailscale's UI, which breaks the headless rule. DEV-0 fixes the one call site. Keep one
  exec helper.
- **The LocalAPI is unstable (`v0`, undocumented).** Keep the CLI fallback and tolerant parsers.
  macsys `sameuserproof` is admin-group only, so non-admin Macs use the CLI.
- **OS prompts:**
  - Windows Firewall will prompt for the inbound listener; add an installer rule scoped to
    `100.64.0.0/10`, or explain it.
  - The macOS application firewall (off by default) prompts once.
  - **macOS 15+ Local Network privacy** will prompt for the tsnet helper, which sends UDP to LAN
    endpoints. It *probably* does not prompt for system-Tailscale traffic over utun. **Measure this**:
    Apple's TN3179 could not be fetched for this doc.
- **Serving machine contention.** Its owner's work comes first. Extra `--parallel` slots cost KV
  memory (about 32.8 KB/token per slot for Qwen3.5-4B, memory *prompt-cache-truth*).
  Model-switch conflicts need the §4.7 policy.
- **Path quality.** DERP paths add latency and cut throughput; image-heavy turns can gain seconds.
  The UI must name the path. Peer Relays help on hard NATs.
- **Sleep and wake.** A sleeping server is just Offline. Tailscale cannot send WoL.
- **Key expiry.** 180 days by default. Needs a clear "Key expired" state (already seen on the user's
  tailnet).
- **Port 8765 is AnkiConnect's default.** Binding the tailnet address avoids clashing with a
  loopback-bound AnkiConnect, but a clash on the same address needs a documented fallback port that
  hello probes also try.
- **Version skew between devices.** Handled by the protocol integer and a clear "update" state.
- **Secrets on Linux without a keyring.** `safeStorage` reports `basic_text` (plaintext). The UI
  must say so.

### Questions for the user

1. **Trust default.** Should Bobble auto-approve your own devices (same Tailscale login) with a
   quiet confirmation, or show an approval dialog on the serving computer for every new device? The
   proposal: auto-approve on a single-user tailnet, dialog otherwise.
2. **Tailscale for v1.** Is it fine that v1 requires Tailscale to be installed (with a link to get
   it)? The alternative is to make Bobble's own built-in connection (tsnet, like LM Studio's LM Link;
   no install, a browser sign-in) part of the first version.
3. **linux-MS-7E59.** Does that box have a desktop session, so the full Bobble app can run there once
   Linux support lands? Or should it get a headless `bobble-node` service? Until then, is a
   hand-started llama-server there ("Add a server by address") a good first milestone?
4. **Scope of v1.** Is chat serving enough for the first version, or should remote image generation
   ship with it?
5. **Who wins on the serving computer.** When someone uses the serving computer and switches its
   model while you are using it remotely, the proposal is: its own user wins and you get a notice.
   Agree?
6. **App-wide or per chat.** One serving device for the whole app (as the running model is today), or
   a per-chat device?
7. **Automatic preference.** Should Bobble prefer a remote device when this Mac is on battery or
   short on memory (today's battery scare)? Or only when you pick it?
8. **Wording.** "Serve from" in the engine menu, "Share this computer's models" for the serving
   switch, and the section name "Devices". Okay?
9. **Port.** Keep port 8765 (also AnkiConnect's default), or pick another fixed port?
10. **The local llama-server exposure** found in §4.11 (permissive CORS on `127.0.0.1`, no key).
    Harden it in this push or separately?
