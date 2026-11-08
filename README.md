# Koru

A personal manga and manhwa reader for Windows, with a liquid glass look you can fully customize.

- **Sources:** Omega Scans and Vortex Scans, read through each site's public pages
- **Library:** favourites, continue reading, new chapter checks, history
- **Reader:** long strip or page by page, right-to-left, ambient light, auto next chapter, keyboard controls
- **Downloads:** save chapters and read them offline
- **Appearance:** every colour with its own transparency, glass blur, glow, animations, fonts, sidebar on any edge (minimizable)

Paid or locked chapters stay locked. Please support the scan groups on their sites.

## Run from source

```
npm install
npm start
```

`npm run dev` serves the app at http://127.0.0.1:5178 for testing in a browser.
`npm run dist` builds the Windows installer into `dist/`.
`npx electron scripts/make-icon.js` rebuilds the icon from `web/img/icon.svg`.

## How it's built

- `electron/main.js` opens the window and serves the app from `koru://app/` (no local port, no Node access in the page).
- `electron/backend.js` talks to the sites (allowed sites only), saves your library and runs downloads.
- `web/` is the whole interface: plain HTML, CSS and JavaScript, no build step.
