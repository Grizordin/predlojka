# anime-cards-render-simple

Minimal package for GitHub + Render.

## Files

- `server.js` - full server in one file.
- `package.json` - dependencies and start command.
- `schema.sql` - Cloudflare D1 schema.
- `client.user.js` - Tampermonkey client script.

## Render

Build Command:

```text
npm install
```

Start Command:

```text
npm start
```

Health Check Path:

```text
/health
```

## Required Render environment variables

```text
ANIMESSS_LOGIN=bot_login
ANIMESSS_PASSWORD=bot_password

CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_D1_DATABASE_ID=...
CLOUDFLARE_API_TOKEN=...

ADMIN_TOKEN=any_long_secret
```

Other settings already have defaults in `server.js`.

## Runtime cache

On startup the service loads authors, cards, suggestions, and tasks from D1 into memory.
Normal scans then read from the in-memory maps and write to D1 only when durable data
actually changes. Author scheduling timestamps and active task progress are checkpointed
every five minutes, while terminal task results are stored immediately.

D1 remains the source of truth after a deploy or restart. The in-memory cache is rebuilt
automatically, so no persistent Render disk is required.

Optional settings:

```text
RUNTIME_CHECKPOINT_INTERVAL_MS=300000
LOG_RETENTION_DAYS=7
RUNTIME_LOG_LIMIT=500
```
