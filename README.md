# Koru

A personal manga and manhwa reader for Windows, with a liquid glass look you can fully customize.

- **Sources (23):** Omega, Vortex, Asura, Flame, MangaDex, Thunder, Madara Scans, King of Shojo, Violet, Rokari, Lagoon, Drake, Elf Toon, Weeb Central, MangaBuddy (Comizy), Hive Toons, Webtoons, Qi Scans, Nyx Scans, Magus Manga, MangaPill, MangaRead and ManhuaPlus, read through each site's public pages and APIs. Free chapters only. (Toonily is hidden for now: its site blocks Koru.)
- **Library:** favourites, continue reading, history, and new chapter checks every 30 minutes while Koru is open (plus when you come back to it), with a desktop notification
- **Reader:** long strip or page by page (with a two-page view for manga), right-to-left, zoom, ambient light, a night filter that can turn on by itself, a clock, an "Up next" countdown into the next chapter, and keyboard controls (press ? for the list)
- **Lively:** a fox that naps when Koru sits idle, perks up at new chapters and cheers when you finish one; reading streaks; 16 badges plus a themed badge for every series you get into (The Greatest Estate Developer: 💰 Love of Money); Koru Wrapped for your month or year; Surprise me and a daily pick
- **Library extras:** your own ratings, notes and shelves; search that merges the same series from every source into one result; "Find on another source" moves your progress to another site when one goes down
- **Downloads:** save chapters and read them offline; the next chapter(s) can save themselves while you read and clear away once read; export chapters or whole series as CBZ files
- **Read together (a mini Discord inside Koru):** sign in with GitHub, make a crew and add friends by their GitHub username. In any chapter, tap the people button and your friends' Koru follows your page as you scroll, into the next chapter too. The Chat tab keeps every message: replies, emoji reactions, edit and delete, pins, bookmarks, reminders, forwarding, search, an emoji picker, meme stickers, pictures and GIFs, and voice messages. Profiles you edit yourself (picture and banner, GIFs too, about me, pronouns, status) show your streak, badges, chapters and top series. Runs on a small Cloudflare Worker (`together-server/`)
- **Sync between PCs:** favourites, likes, bookmarks, history, read marks, ratings, notes and shelves stay the same on your PCs, through a folder both can see (OneDrive, Google Drive, Dropbox or a USB stick) or your own private GitHub repo, which also syncs stats, streaks and badges
- **Updates:** Settings → About checks GitHub and installs new versions in one click, no account or key needed
- **Appearance:** every colour with its own transparency, gradients, your own wallpaper, saved looks, glass blur, glow, animations, fonts, sidebar on any edge (minimizable), and a light mode for PCs without a working graphics card

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
