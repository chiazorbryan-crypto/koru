# Koru

A personal manga and manhwa reader for Windows, with a liquid glass look you can fully customize.

- **Sources (23):** Omega, Vortex, Asura, Flame, MangaDex, Thunder, Madara Scans, King of Shojo, Violet, Rokari, Lagoon, Drake, Elf Toon, Weeb Central, MangaBuddy (Comizy), Hive Toons, Webtoons, Qi Scans, Nyx Scans, Magus Manga, MangaPill, MangaRead and ManhuaPlus, read through each site's public pages and APIs. Free chapters only. (Toonily is hidden for now: its site blocks Koru.)
- **Library:** favourites, continue reading, history, and new chapter checks every 30 minutes while Koru is open (plus when you come back to it), with a desktop notification
- **Reader:** long strip or page by page (with a two-page view for manga), right-to-left, zoom, ambient light, a night filter that can turn on by itself, a clock, an "Up next" countdown into the next chapter, and keyboard controls (press ? for the list)
- **Lively:** a fox that naps when Koru sits idle, perks up at new chapters and cheers when you finish one; reading streaks (5 restores a month, and a pause); 16 badges plus a themed badge for every series you get into (The Greatest Estate Developer: 💰 Love of Money); Koru Wrapped for your month or year; Surprise me and a daily pick
- **Library extras:** your own ratings, notes and shelves; search that merges the same series from every source into one result; "Find on another source" moves your progress to another site when one goes down
- **Downloads:** save chapters and read them offline; the next chapter(s) can save themselves while you read and clear away once read; export chapters or whole series as CBZ files
- **Read together (a mini Discord inside Koru):** sign in with GitHub, make a crew and add friends by their GitHub username. In any chapter, tap the people button and your friends' Koru follows your page as you scroll, into the next chapter too. The Chat tab keeps every message: replies, emoji reactions, edit and delete, pins, bookmarks, reminders, forwarding, search, an emoji picker, meme stickers, pictures and GIFs, and voice messages. Profiles you edit yourself (picture and banner, GIFs too, about me, pronouns, status) show your streak, badges, chapters and top series. Runs on a small Cloudflare Worker (`together-server/`)
- **Sync between PCs:** favourites, likes, bookmarks, history, read marks, ratings, notes and shelves stay the same on your PCs, through a folder both can see (OneDrive, Google Drive, Dropbox or a USB stick) or your own private GitHub repo, which also syncs stats, streaks and badges
- **Updates:** Settings → About checks GitHub and installs new versions in one click, no account or key needed
- **Discover:** a Trending tab that merges every source's popular list, a "Completed only" filter, "More like this" picks from what you read and rate, and Release days: a weekly calendar of when your favourites usually update
- **Reader extras:** panel-by-panel mode (G), sharpen blurry pages (E), ambient sounds made on the fly (rain, night wind, café, fireplace, lo-fi), translate raw Korean/Japanese/Chinese chapters (OCR + translation, overlaid on the bubbles), and a spoiler-free "Previously on…" card when you come back to a series
- **Your own touches:** tag characters on pages and see where they appear, set any page as your desktop wallpaper, send a page to your crew, a mini reader window that stays on top, Ctrl+K to jump anywhere, a desktop widget with Up next and new chapters, and import your list from Mihon/Tachiyomi, MyAnimeList, AniList or a MangaDex list
- **Kitsu:** a reading assistant (a floating, movable pop-up, or its own tab) that knows your library, history and stats, suggests what to read with reasons, finds a series from a description, and can open, shelve and rate for you after asking. Its brain is KitsuNet, small networks trained on public AniList reading lists (`kitsunet/`), plus an optional on-device model that writes the replies (no API key, nothing leaves your PC)
- **Music + Glasswave:** your Glasswave inside Koru (playlists, liked songs, your YouTube Music playlists, history and downloads; downloaded songs play from Glasswave's own files, offline and without ads), link another Glasswave folder, paste a YouTube Music link to play it, plus YouTube Music search, a player bar, Now playing with Up next and lyrics, and a hidden reveal corner while reading (`web/js/music*.js`)
- **Series colours:** each series page and its reader take their accent colours from the cover (Subtle / Normal / Strong, or off)
- **Quiet source check:** if a source stays down, Koru moves your favourites to another source that has the same series (history, read marks and ratings follow), and offers to move them back when it works again
- **Now playing:** a little player in the sidebar for music on your PC (Glasswave, Spotify, a browser…), through Windows' media controls (`native/koru-media.cs`)
- **Taskbar:** hide the Windows taskbar until the mouse reaches the bottom edge (a tiny helper, `native/koru-taskbar.cs`, keeps it working with Koru closed), and make it fully clear so only the icons show (sets up TranslucentTB)
- **Appearance:** a live preview of your look while you make it (hover a preset to try it first), every colour with its own transparency, gradients, your own wallpaper, saved looks, glass blur, glow, animations, fonts, sidebar on any edge (minimizable), and a light mode for PCs without a working graphics card

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
