# Chrome Web Store Description (English)

---

## Short Description (132 characters max)

AI-powered spoiler filter for YouTube game stream chats. Works on archives and live streams. No account needed — just install and play.

---

## Full Description

### Fresh Chat Keeper — Spoiler Filter for Game Stream Chats

Have you ever had your enjoyment ruined by spoilers, hints, or unsolicited advice flooding the chat while watching a game stream or archive? Fresh Chat Keeper puts a stop to that.

**Fresh Chat Keeper** is a Chrome extension that automatically detects and hides spoiler comments in YouTube game stream chats, so you can watch at your own pace without fear of spoilers.


### Key Features

**2-Stage AI Filtering**
- Stage 1 (instant): Fast keyword matching that catches obvious spoilers immediately
- Stage 2 (AI): Claude AI reads context to distinguish genuine spoilers from innocent comments
- Double-layer design minimizes both false positives and missed spoilers

**Archive & Live Support**
- Filters chat replays on archived (VOD) streams
- Also works on live streams in real time

**Genre Templates**
- Select a genre (RPG, Mystery, Action-Horror, etc.) to improve detection accuracy without needing a game-specific database
- Detects gameplay advice and instruction-style comments ("there's somewhere you haven't been yet," "this is a scripted loss") that can also ruin the experience

**Progress-Aware Filtering**
- Register how far you've progressed in the game, and Fresh Chat Keeper won't hide comments about content you've already seen
- Automatically distinguishes spoilers ahead of your progress from content you've already seen

**Auto Game Detection from Video Title**
- Automatically infers the game being played from the video title for smarter AI judgment — no manual setup needed

**Custom Block Words**
- Build your own block list for any words or phrases you want to hide instantly

**3 Filter Strength Levels**
- Strict: Block spoilers, foreshadowing, and gameplay advice
- Standard: Block clear spoilers and foreshadowing only (default)
- Lenient: Block only explicit spoilers


### How to Use

1. Install from the Chrome Web Store (no account or login required)
2. Open any YouTube game stream page
3. Click the Fresh Chat Keeper icon in the top-right corner
4. Select your game title or genre — done

Settings apply instantly. Fresh Chat Keeper works automatically from that point on.


### Privacy

- **All data stored locally**: Settings and cached results are stored only in your browser — never on external servers
- **Chat content is never logged**: Comment text is sent to our AI service for judgment, but is never stored or recorded
- **No API key needed**: Fresh Chat Keeper manages API access through a secure proxy — you don't need to provide any keys
- **No account required**: Install and use immediately, no sign-up needed

#### Optional Data Collection (opt-in, v0.3.5 and later)

For users who want to help improve spoiler detection, we now offer an opt-in feature to store judgment logs on our servers.

- **Disabled by default.** Activated only by explicitly toggling the switch in the popup and confirming via the consent dialog
- Author identifiers are SHA-1 hashed on the server; plaintext values are never stored
- Revoke at any time from the popup. Revocation also deletes past server-side logs (within the last 90 days)
- See the "Opt-in Data Collection" section in the Privacy Policy for details

Full privacy policy: https://github.com/delacunaworks/fresh-chat-keeper/blob/main/docs/privacy-policy.md


### A Note on Accuracy

Fresh Chat Keeper uses AI to understand context, but cannot guarantee every spoiler will be caught. Detection accuracy is highest for games with dedicated support in our database. For other titles, enabling genre templates and custom block words can significantly improve results. If something is incorrectly filtered, use the "❌ False positive" button next to the comment to report it — your reports help us improve future accuracy.


### Supported Platforms

- YouTube (archives and live streams)


### Source Code

Fresh Chat Keeper is open source:
https://github.com/delacunaworks/fresh-chat-keeper