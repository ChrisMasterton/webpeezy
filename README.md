# Webpeezy

A fast, lightweight desktop app for converting images to WebP format with customizable presets.

## Features

- **Drag & drop** - Drop images directly into the app or click to browse
- **Batch conversion** - Convert multiple images at once
- **Custom presets** - Create and save presets with configurable:
  - Maximum width/height (auto-scales proportionally)
  - Quality (1-100%)
- **Real-time preview** - See converted images and file size savings instantly
- **Download all** - Export all converted images with one click

## Tech Stack

- React 19 + TypeScript
- Vite
- Tauri 2 (desktop)
- Motion (animations)

## Development

```bash
# Install dependencies
npm install

# Run web dev server
npm run dev

# Run desktop app
npm run tauri:dev

# Build desktop app
npm run tauri:build
```

## Verification

```bash
# Install the browser once after npm install
npx playwright install chromium

npm test
npm run build
npm run lint
```

For the desktop encoder and a local macOS app bundle:

```bash
cargo test --release --manifest-path src-tauri/Cargo.toml --lib --locked
npm run tauri:build -- --bundles app
```

The desktop app uses libwebp when its webview cannot encode WebP through canvas.
Native export checks should confirm the saved files contain WebP data, preserve
existing filenames, open the destination folder, and allow retry after a write
failure. The app bundle is created in `src-tauri/target/release/bundle/macos/`.

The browser regressions start their own local server and use isolated storage and
temporary export folders. They check saved presets, image dimensions, downloaded
bytes, keyboard actions, and export retries. Desktop export tests substitute the
Tauri IPC layer with temporary file operations; native dialogs and permissions
still require verification in the desktop app.
