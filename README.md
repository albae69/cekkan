# cekkan

A fast, local-first desktop API client — a lightweight alternative to Postman and HTTPie, built with [Tauri 2](https://tauri.app), React and Rust.

No account, no cloud, no telemetry. Requests go straight from your machine.

## Features

**Requests**
- GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS with per-request timeout and cancel
- Headers and query params as editable rows (enable/disable per row)
- Body modes: none, raw (JSON / text / XML / HTML), `x-www-form-urlencoded`, `multipart/form-data` with file upload, binary file body
- Auth presets: Bearer token, Basic auth, API key (header or query)
- Environment profiles with `{{variable}}` substitution in URL, headers, body and auth
- Copy request as `cURL`
- Keyboard: <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> to send, <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>S</kbd> to save

**Response**
- Status, duration, payload size, response headers
- Pretty-printed JSON with syntax highlighting
- Optional raw view

**Workspace**
- Collections tree: folders, requests, rename, duplicate, delete, filter/search
- Save / Save as, multiple request tabs
- History of the last 100 requests — click to reopen
- Import: Postman collection v2.1 and HTTPie collection JSON
- Export/import collections as JSON

## Install

Prebuilt macOS builds (Apple Silicon) are attached to [Releases](../../releases). The app is ad-hoc signed; if macOS blocks it, right-click → **Open**, or run:

```bash
xattr -dr com.apple.quarantine /Applications/cekkan.app
```

Windows and Linux builds can be produced from source.

## Build from source

Requirements:

- [Rust](https://rustup.rs) (stable)
- Node.js 20+ or [Bun](https://bun.sh) 1.2+
- Platform toolchain: Xcode Command Line Tools (macOS), MSVC + WebView2 (Windows), `webkit2gtk`/`libgtk-3`/`librsvg`/`libayatana-appindicator` (Linux)

```bash
npm install          # or: bun install
npm run tauri dev    # start the app in dev mode
npm run tauri build  # produce a bundle in src-tauri/target/release/bundle
```

Bundles:

- macOS: `.app`, `.dmg`
- Windows: `.msi`, `.exe`
- Linux: `.deb`, `.rpm`, `.AppImage`

## Checks

```bash
npm run build   # type-check + production frontend build
npm run check   # URL/header builder, cURL, importers, tree ops
cargo check --manifest-path src-tauri/Cargo.toml
```

## Usage notes

- `{{base_url}}` is replaced from the selected environment. Use the Env panel in the sidebar to add profiles.
- Import accepts Postman v2.1 (`item[]`) and HTTPie (`entry.requests[]`) exports.
- Imported requests land in a new collection; unsaved changes are marked with `•` on the tab.

## Data & privacy

- Tabs, collections, history and environments are stored locally in WebView `localStorage`.
- Requests are executed by Rust (`tauri-plugin-http`), so responses are not subject to browser CORS.
- The app can call any `http://` or `https://` endpoint you provide. It has no analytics, updater or background network activity.
- File reads/writes only happen for paths you select in the native open/save dialog.

## Limitations

- Large uploads are slower than ideal: file bytes are transferred over IPC as a byte array.
- Response panel is shared across tabs (not per-tab).
- No request scripts/assertions, cookie jar, proxy config, OAuth2 flows, WebSocket or gRPC yet.
- `multipart/form-data` supports one file per field row (add rows for multiple files).
- Collections cannot be reordered by drag and drop.

## Project layout

```
src/
  App.tsx      UI: panels, tabs, collections, request/response
  model.ts     types, env substitution, URL/header builder, cURL, importers, tree ops
  App.css      light theme
scripts/
  check.mjs    assert-based checks for model logic
src-tauri/
  src/lib.rs   Tauri plugins + file read/write commands
  tauri.conf.json
```

## Contributing

Issues and pull requests are welcome. Please run `npm run build` and `npm run check` before opening a PR.
