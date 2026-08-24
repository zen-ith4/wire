# Wire Desktop Client (Electron)

This is a **client-only** Electron wrapper for the existing Wire website.
It contains **no backend code** — no Express, no Socket.IO server, no
database. It never starts a local server. All it does is:

1. Ask the user which server to connect to (first launch, or if the
   saved server can't be reached).
2. Remember that address for next time.
3. Load the real website straight from that remote server, inside a
   secure Electron window.

Because the existing website already talks to its own backend using
relative URLs (`/api/...`, and `io()` with no arguments, both of which
resolve against whatever origin the page was loaded from), no changes
to the website's frontend or backend code were required for this to
work — loading the site from `http://192.168.1.100:3000/` makes every
relative `fetch()` and the Socket.IO client automatically target
`192.168.1.100:3000`.

## Folder contents

```
electron-client/
├── package.json      # deps + electron-builder config (Windows target)
├── main.js           # main process: window, address validation, IPC
├── preload.js         # exposes a minimal API to the local connect screen only
├── renderer/
│   ├── connect.html   # "choose your server" screen
│   ├── connect.css
│   └── connect.js
└── build/             # optional: put icon.ico here if you want a custom icon
```

## Development

```bash
cd electron-client
npm install
npm start
```

This launches the Electron app pointed at nothing in particular — it
will show the connect screen, and you enter your dev server's address
(e.g. `http://localhost:3000` if you're running the backend locally,
or `http://192.168.1.x:3000` for a LAN box).

## Building

```bash
cd electron-client
npm install
```

Then:

| Command | Produces | Requires |
|---|---|---|
| `npm run dist:win` | `dist/Wire Setup 1.0.0.exe` | Windows host, **or** Linux/macOS host with [Wine](https://www.winehq.org/) installed |
| `npm run dist:linux` | `dist/Wire-1.0.0.AppImage`, `dist/Wire-1.0.0.deb` | Linux host (native `dpkg`/`fpm` tooling, handled by electron-builder) |
| `npm run dist` | Both of the above | Whatever the two rows above require, combined |

These have been verified in this environment: `npm run dist:linux`
was run for real and produced both `dist/Wire-1.0.0.AppImage` and
`dist/Wire-1.0.0.deb`; the packaged app was launched and its
connect screen confirmed working, and the `.deb`/`.AppImage`
contents were inspected to confirm the real Wire icon (not the
default Electron icon) is embedded at every required size
(16–1024px) and correctly wired into the `.desktop` entry.

### Can Linux packages be built from Windows?

**No, not reliably** — this was tested directly. AppImage and `.deb`
packaging both depend on Linux-native tooling (`dpkg-deb`, `fpm`,
`squashfs`) that electron-builder does not emulate on Windows. The
reverse also has a hard requirement: building the **Windows** `.exe`
from a Linux host requires **Wine** to be installed — attempting it
without Wine fails immediately with `wine is required` (confirmed in
this environment).

**Simplest reliable method — build each platform's package on that
platform, or use WSL2 on Windows for the Linux targets:**

1. Install [WSL2](https://learn.microsoft.com/windows/wsl/install)
   with an Ubuntu distro (`wsl --install -d Ubuntu`).
2. Inside the WSL2 Ubuntu shell, install Node.js (matching the
   version used for development, e.g. via `nvm` or `apt`) and, if not
   already present, `dpkg` (present by default on Ubuntu).
3. Copy or clone the project into the WSL2 filesystem (e.g.
   `/home/<user>/wire/electron-client`) — building against a
   Windows-mounted path (`/mnt/c/...`) works but is noticeably slower.
4. From that WSL2 shell:
   ```bash
   cd electron-client
   npm install
   npm run dist:linux
   ```
5. The `.AppImage` and `.deb` land in `electron-client/dist/` inside
   WSL2; copy them out to Windows (e.g. `cp dist/*.AppImage dist/*.deb /mnt/c/Users/<you>/Desktop/`) to share them.

**Alternative — Docker**, if you'd rather not set up WSL2:
```bash
docker run --rm -ti \
  -v "$(pwd)":/project \
  -w /project \
  electronuserland/builder:20 \
  /bin/bash -c "npm install && npm run dist:linux"
```
This uses Anthropic's/electron-builder maintainers' official build
image, which already has all Linux packaging tools preinstalled — no
Wine needed for this direction since we're only asking it for Linux
targets.

The Windows `.exe` should still be built either on an actual Windows
machine (`npm run dist:win` in a normal Windows `cmd`/PowerShell —
this is the simplest, most reliable path and needs nothing extra) or
via the same Docker image with Wine included
(`electronuserland/builder:wine`) if you specifically need to produce
the `.exe` from Linux/WSL2/CI.

## Application icon

The app's icon is generated from the site's existing logo at
`public/img/logo.jpg` (the same 1024×1024 mark used in the sidebar
brand mark in `public/index.html`) — nothing new was designed. Two
related edits were made to that mark, both purely cosmetic
corner-softening (same "W" shape, proportions, colors, exact same
design otherwise):

1. **The W's own sharp outer corners are slightly rounded** —
   applied everywhere the mark appears (website logo, connect-screen
   logo, app icon).
2. **The native app icon (taskbar/Explorer/Linux launcher) is now a
   rounded-square "squircle" with transparent corners**, instead of a
   flat, hard-edged square. This is separate from #1: it only applies
   to the standalone OS-level icon files (`build/icon.png`,
   `icon.ico`, `icons/*.png`), not to `public/img/logo.jpg` — the
   website's logo stays a plain square JPEG (JPEG has no alpha
   channel anyway), since the page's own CSS (`.login-mark{border-radius:var(--radius-lg)}`)
   already clips it neatly wherever it's used inline. The squircle
   treatment specifically fixes the "blocky square icon in the
   taskbar" look, which is most visible on Linux desktops that don't
   auto-round application icons.

Generated assets live in `electron-client/build/`:

- `build/icon.png` — 1024×1024 RGBA master (squircle, transparent
  corners), also used at runtime for the `BrowserWindow` icon (see
  `main.js`).
- `build/icon.ico` — multi-resolution Windows icon (16/24/32/48/64/128/256px),
  alpha-transparent, used for the `.exe`, its taskbar/Explorer icon,
  and the NSIS installer/uninstaller wizard icon.
- `build/icons/*.png` — 16 through 1024px, alpha-transparent, used
  for the Linux AppImage and `.deb` (`hicolor` icon theme sizes +
  `.desktop` entry).

Verified directly: rebuilt the AppImage after this change, extracted
its embedded icon, and confirmed real alpha transparency in the
corners (checkerboard-composited to check) at all sizes down to
32×32.

No macOS target was configured (none was requested), so no `.icns`
was generated — if you add macOS packaging later, electron-builder
can generate a `.icns` from `build/icon.png` automatically as long as
it's built on a Mac (or via a `png2icns`-capable tool).

One thing to update yourself: `package.json`'s top-level `"homepage"`
field is currently a placeholder (`https://example.com/wire`) — it's
required by the `.deb` format's control file but has no effect on
functionality. Replace it with your project's real URL before
distributing the `.deb`.

## How server selection works

- On first launch (no saved address), the app shows the connect
  screen immediately.
- The user types an address in any of these forms:
  - `192.168.1.100:3000`
  - `http://192.168.1.100:3000`
  - `https://example.com`
  - `example.com` (defaults to `http://`)
- `main.js` normalizes this into a clean origin (e.g.
  `http://192.168.1.100:3000`) using `URL.origin`, then does a real
  HTTP request to confirm something is actually listening there.
- On success, the address is saved to
  `app.getPath('userData')/server-config.json` and the main window
  navigates to that server — the real website loads and takes over
  the window.
- On failure, an error is shown on the connect screen and the user can
  edit the address and retry.
- On every subsequent launch, the app reads the saved address and
  automatically tries it first (showing "Connecting to previous
  server…"). If that fails (server offline, address changed, etc.),
  it falls back to the connect screen with an explanation.
- **Server → Change Server…** in the menu bar (or `Ctrl+Shift+S`) lets
  the user jump back to the connect screen at any time to switch
  servers, without reinstalling or hunting through settings.

## Security notes

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- `preload.js` only exposes its `window.wireClient` API when running
  on the local `file://` connect screen — the remote website never
  gets access to any Electron/Node API.
- New-window requests (`target="_blank"`, `window.open`, OAuth-style
  popups) are redirected to the user's default OS browser instead of
  opening inside Electron.
- Navigating the main window to any origin other than the
  currently-connected server (or the local connect screen) is blocked
  and sent to the OS browser instead.

## A note on the backend server itself

`server.js` in the parent project defaults to binding on
`HOST=127.0.0.1`, which only accepts connections from the same
machine. For other PCs (or this Electron client running on a
different machine) to reach it over the LAN, the backend needs to
bind to an address reachable from the network — e.g. set `HOST=0.0.0.0`
(or the machine's LAN/WireGuard IP) in its `.env` before starting it.
This is a backend deployment setting, unrelated to the Electron client
itself.
