# Configuration

Configuration lives in `config.json` in the extension's installed folder. When the shared browser blocks an address, the page it shows gives that file's exact path. Copy `config.example.json` to start.

- **Restart after editing.** Changes apply when the extension restarts.
- **Back it up.** The file is excluded from Git and from the package, so keep a copy before reinstalling or updating.
- **Folder installs.** For a folder installation, clone this repository, configure it, and install its absolute path through OpenChamber's extension settings.

## Local development servers

Private and loopback destinations are blocked unless you allow them. List the exact origins you need:

```json
{
  "allowedOrigins": [
    "http://127.0.0.1:3000",
    "http://localhost:3000"
  ]
}
```

Origin grants work as follows:
- They distinguish HTTP from HTTPS and include WebSocket traffic on the same host and port.
- They match the host name in the address, not what it resolves to. A domain that resolves or rebinds to a granted address cannot reach it, and an alias such as `myapp.test` needs its own entry.
- `localhost` also uses the grants for `127.0.0.1` and `[::1]`, because the service resolves it itself.
- A page that loads assets from, or calls, another private origin needs that origin allowed too.

`localhost` means the machine running the extension, so an SSH-forwarded port must be reachable there.

## Private networks

For several machines or many ports, list a private IPv4 block in `allowedNetworks` with the ports it may use:

```json
{
  "allowedNetworks": [
    { "cidr": "192.168.1.0/24", "ports": [3000, "5173-5199", 8080] }
  ]
}
```

- Ports are required, and a `"first-last"` string covers a range.
- A block applies to HTTP, HTTPS, and WebSocket traffic.
- A block must be private or loopback, and no broader than /8.

A block matches the address a name resolves to. So it also allows any domain that resolves into it on a listed port, including one a page rebinds there. Keep blocks and port lists narrow, and list loopback servers in `allowedOrigins` rather than as a loopback block.

## Discovering development servers

To reach development servers without listing them, set `"discoverDevServers": true`. The service then allows loopback ports with a live listener, over IPv4 and IPv6. It checks again at most every three seconds, so a server that stops loses access.

- **Platforms.** Discovery needs Linux, which uses `lsof` when installed and `/proc` otherwise, or macOS with `lsof`. On other systems it allows nothing.
- **Names.** `localhost` uses whichever loopback family the server listens on. Discovery grants only `127.0.0.1`, `[::1]`, and `localhost`, so another name that resolves to loopback stays blocked.
- **Never granted.** Ports held by OpenChamber itself, by its other child processes such as OpenCode and other extension services, or by this extension and its Chrome. Discovery allows nothing when it cannot tell which process owns a port.
- **Always skipped.** SSH, DNS, SMB, printing, common database ports, and the Node.js inspector port.
- **Everything else becomes reachable.** Every other loopback listener on the machine can be reached from pages in the shared browser, including databases on other ports, a second OpenChamber or OpenCode, and other browsers' debugging ports. Keep discovery off where that matters.

## Addresses that stay blocked

Link-local, cloud metadata, CGNAT, IPv6 transition, and reserved ranges stay blocked even when listed.

A blocked plain-HTTP address opens a page that:
- names the origin;
- gives the path of `config.json` and the entry to add;
- for a loopback address, says whether discovery is off or found no eligible server.

HTTPS navigations to a blocked address end in Chrome's own `ERR_TUNNEL_CONNECTION_FAILED`.

## Chrome

The service looks for Chrome or Chromium 109 or newer in standard locations. If it finds none, or picks the wrong one, set the path:

```json
{
  "chromePath": "/absolute/path/to/chromium"
}
```

Use a full Chrome or Chromium build. `chrome-headless-shell` lacks the DevTools frontend.

## Persistent profiles

By default each chat's Chrome runs on a temporary profile, and its cookies, storage, and sign-ins go when the browser closes. Set `profileRoot` to an absolute directory to keep them:

```json
{
  "profileRoot": "/var/lib/openchamber-server-browser"
}
```

- **One directory per chat.** Each `{ directory, sessionId }` pair gets its own subdirectory, so two chats never open one profile at once.
- **What survives.** Cookies, local storage, and the cache survive idle expiry and a service restart. Open tabs, history, and the current page do not, and a browser still starts on a blank page.
- **Growth.** The directory grows with use. Delete it to clear every saved sign-in and cookie.
- **Temporary again.** Set `"profileRoot": null` or remove the key to go back to temporary profiles.

A persistent profile carries a lease in `<profileRoot>/<chat>/.openchamber-lease/owner.json`. The service renews it every 10 seconds and treats a lease without a heartbeat for 45 seconds as abandoned. It removes stale Chrome `SingletonLock`, `SingletonCookie`, and `SingletonSocket` entries only while holding that lease, so a second service using the same profile is refused instead of having the live one's locks deleted. Do not share one `profileRoot` between two running services.

The first upgrade from a version without leases needs a one-time manual cleanup: stop the old service, then remove `.openchamber-lease`, `SingletonLock`, `SingletonCookie`, and `SingletonSocket` from each existing profile. Recovery is automatic after that. If Chrome fails to start, the error includes a redacted tail of its stderr, and a later request can retry without restarting OpenChamber.

## Surface tuning

The frames the service sends to the panel can be tuned:

```json
{
  "surface": { "quality": 72, "everyNthFrame": 1 }
}
```

- `quality` is the JPEG quality of each frame, from 1 to 100. The default is 72.
- `everyNthFrame` sends one frame out of every N, from 1 to 10. The default is 1; `2` is roughly 30 frames per second on a 60 Hz display and halves the bandwidth.

