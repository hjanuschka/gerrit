# gerrit-chat-service

Node.js service used by the `gerrit-chat` Gerrit plugin.

It runs a **real conversational session per CL** (project + change number), inspired by
`rephraser/src/chat-server`, and keeps that session warm in memory with a TTL.

Sessions are persisted as **JSONL files** via `SessionManager.continueRecent()`:

- Root dir: `CHAT_SESSIONS_ROOT` (default: `services/gerrit-chat-service/.chat-sessions`)
- Layout: `<root>/<project>/<change>/...jsonl`

## Run locally

```bash
cd services/gerrit-chat-service
npm install
GERRIT_BASE_URL=http://localhost:8080 \
GERRIT_USERNAME=admin \
GERRIT_PASSWORD=secret \
PORT=8787 \
npm start
```

Optional PI AI integration modes:

1. **pi-ai SDK with OpenAI key** (recommended for your setup)

```bash
OPENAI_API_KEY=... \
OPENAI_MODEL=gpt-5.3-codex \
npm start
```

The service uses `@mariozechner/pi-ai` (`complete()` + `getModel()`) and maps
`gpt-5.3-codex` to `gpt-5-codex` if needed.

You can control where per-CL JSONL sessions are stored with:

```bash
CHAT_SESSIONS_ROOT=/path/to/chat-sessions
```

2. **External PI-compatible HTTP endpoint**

```bash
PI_AI_URL=http://127.0.0.1:9000/chat/respond npm start
```

`PI_AI_URL` should accept `{prompt, context}` and return
`{assistantMessage}` or `{text}`.

## Configure Gerrit plugin

In `$GERRIT_SITE/etc/gerrit.config`:

```ini
[plugin "gerrit-chat"]
  nodeUrl = http://127.0.0.1:8787
```

Then reload plugin:

```bash
$GERRIT_SITE/bin/gerrit.sh restart
# or plugin reload gerrit-chat
```
