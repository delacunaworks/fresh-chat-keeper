# Chrome Web Store Description (English)

---

## Short Description (132 characters max)

AI filter for YouTube game-stream chat: spoilers, harassment, spam, backseating. User blocking. Archives & live. No account needed.

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

**Multi-Category Filtering (new in v0.4.0)**
- Beyond spoilers, the AI also classifies harassment, spam/flooding, off-topic / other-streamer mentions, and backseat gaming
- Toggle each category on/off and set its strength independently (new categories are off by default — enable only what you want)

**User Blocking (new in v0.4.0)**
- Block a poster in one click and hide their comments, including past ones
- Undo support and a block-list manager. Block info is stored only on your device

**Automatic Spam Detection (new in v0.4.0)**
- Detects repeated comments, URL flooding, and emoji spam before the AI call

**Viewer Flagging (new in v0.5.0, opt-in)**
- Visualizes viewers who repeatedly trigger filters across 4 levels (clean / minor / caution / warning) to support your blocking decisions
- Choose display style (icon / color / hover-only / red-only), tracking window (session / 7 days / 30 days), and sensitivity
- "📊 View stats" next to a comment shows per-viewer breakdowns and a daily trend; the "Flagged viewers" tab supports bulk blocking
- Off by default. All stats are stored only on your device and never sent externally (distinct from the v0.3.5 opt-in data collection)

**Caption Context (new in v0.6.0, experimental, opt-in)**
- On streams where YouTube captions (CC) are displayed, adds the streamer's recent speech to the AI's judgment context to assist spoiler and other detection
- Captions are read in the browser; they are included in the judgment request and sent only while ON (no audio is recorded)
- For game streams with sparse auto-captions the effect is limited — in that case it does nothing and works as usual
- Off by default (opt-in). While OFF, behavior is exactly identical to v0.5.0

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

Fresh Chat Keeper uses AI to understand context, but cannot guarantee every spoiler (or other flagged comment) will be caught. Detection accuracy is highest for games with dedicated support in our database. For other titles, enabling genre templates and custom block words can significantly improve results. If something is judged incorrectly — either wrongly filtered or missed — open the "⋯" menu next to the comment and choose "⚠️ Report" to submit the kind and category — your reports help us improve future accuracy.


### Supported Platforms

- YouTube (archives and live streams)


### Source Code

Fresh Chat Keeper is open source:
https://github.com/delacunaworks/fresh-chat-keeper