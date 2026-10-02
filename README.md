# BYR — Build Your Reels

A lightweight, browser-first workspace for building photo and video stories. The app is TypeScript, Vite, and Sass with no UI framework or runtime package dependencies. Projects and source media stay in browser storage; the app makes no media upload, analytics, account, or cloud requests.

## Requirements

- Node.js 20.19+ (or 22.12+)
- npm

## Develop

```sh
npm install
npm run dev
```

## Build and preview

```sh
npm run build
npm run preview
```

The production-ready static site is written to `dist/`. Deploy that folder to any static hosting provider. The host serves app files only; no application server is required.

## GitHub release and Pages deployment

Two GitHub Actions workflows live in `.github/workflows/`:

1. Run **Actions → Build production release → Run workflow**, choose a version suffix such as `1.0`, and start the workflow from the commit you want to release. It runs the production TypeScript/Vite build first, then creates a UTC day-month-year tag such as `2-10-2026-v1.0`. The GitHub Release includes generated notes and a `byr-dist.tar.gz` asset containing only the generated `dist/` files. It dispatches the deployment workflow after the asset is published. A tag cannot be reused, so choose another suffix if that date/version already exists.
2. **Deploy release dist to GitHub Pages** downloads `byr-dist.tar.gz` from the selected release and publishes those built files directly; it does not rebuild the source. You can also run it manually and provide the complete tag. Repository Pages must be enabled with **Build and deployment → Source: GitHub Actions**.

The release workflow sets Vite's base path for both project sites (`/<repository>/`) and user/org sites (`/`). Git tags still identify the source commit; the production-only release asset is the exact artifact deployed to Pages.

## Implemented features (Phases 0–2 and 5)

- Local-first project creation, opening, rename, duplication, deletion, and recent-project ordering.
- Import photos and videos with the file picker, drag and drop, or a folder picker where supported.
- Media thumbnails and metadata, searchable/sortable grid or list views, preview selection, and remove-from-project.
- Versioned project records and media blobs stored in IndexedDB, with storage usage information.
- Export/import portable `.byr` project packages. Packages contain a copy of project media and are limited to 120 MB of source media to keep browser memory use bounded.
- User-selected media is copied into this browser's local database. Browser storage may be cleared or evicted, so use project packages to make portable backups.
- Non-destructive photo controls: brightness, contrast, saturation, temperature, highlights, shadows, looks, zoom, rotate, flip, fit/contain, background color, and editable text/shape/frame overlays with ordering and placement controls.
- Direct canvas layer dragging, corner-handle resizing, keyboard movement, layer opacity/color, caption font and alignment controls, and additional line/arrow/star/heart/speech-bubble objects.
- Adjustable Overlay, Color Burn, Multiply, Screen, and Soft Light filters, alongside Warm, Cool, Monochrome, and Fade looks.
- Editable canvas aspect ratios, undo/redo, autosaved photo edits, and project-package round-tripping for edits and sequence data.
- A basic ordered sequence with still/video clips and adjustable durations; image export as PNG, JPEG, or WebP, plus browser-supported real-time video export through MediaRecorder.
- Export resolution, quality, frame-rate controls, progress/cancel feedback, capability-aware errors, and a local-data erase action.

Video export is currently a lightweight sequence renderer, not a full video editor: it has no clip trimming, audio, transitions, or frame-accurate timeline. Video output depends on the browser's MediaRecorder codec support, is capped at 120 seconds, and is silent. Still-image formats are checked against the actual browser output. Keep the original media and a `.byr` backup for important work.

## Project structure

```text
src/
  app/app-controller.ts       # Coordinates UI and application services
  domain/models.ts            # Versioned project/media types
  media/media-service.ts      # Import validation, metadata, thumbnails
  media/media-library-view.ts # Search, sort, grid/list, selection
  projects/project-bundle.ts # Client-side package import/export
  storage/database.ts         # IndexedDB persistence
  storage/storage-info.ts     # Quota and usage information
  ui/dialog.ts                # Accessible project dialogs
  ui/toast.ts                 # Status messages
  editor/                      # Photo edit model, canvas rendering, and editor controls
  export/                      # Still-image and sequence export
  errors/                      # App-level error boundary and recovery messaging
  styles/main.scss             # Sass entry point
  styles/_tokens.scss          # Shared design tokens
  styles/_shell.scss           # App shell and media library styles
  styles/_photo-editor.scss    # Photo editor workspace styles
  styles/_export.scss          # Export and recovery styles
  main.ts                     # Application entry point
```

See [PHASE_PLAN.md](./PHASE_PLAN.md) for the remaining product roadmap and client-only architecture constraints.
