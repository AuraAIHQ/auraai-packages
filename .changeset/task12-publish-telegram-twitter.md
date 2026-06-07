---
"@auraaihq/publish-telegram": minor
"@auraaihq/publish-twitter": minor
---

Add Telegram and Twitter publisher capability modules backed by CBots sidecar:

**`@auraaihq/publish-telegram`**
- `send` intent: broadcast a message to any Telegram channel/group/topic via CBots `/api/send_message`
- Supports: channel username, private channel link, public channel link, group/topic id
- Optional: `topicId`, `scheduledTime` (ISO 8601), `imageUrl`
- Configurable `cbotsUrl` per intent (default: `http://localhost:8872`)

**`@auraaihq/publish-twitter`**
- `tweet` intent: post a tweet via CBots `/api/send_tweet`
- Supports: `scheduledTime`, `imageUrl`
- `last-tweet-url` intent: reserved for M2 (returns null for now)

**CBots submodule**: `cbots/` added as a git submodule (Python/Telethon/Tweepy sidecar service)
pinned to commit 52771e4. See `cbots/README.md` for setup and API key configuration.
