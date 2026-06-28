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
