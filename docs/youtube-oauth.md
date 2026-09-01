# YouTube OAuth credentials

Uploads use **Google OAuth**, not a YouTube API key and not a value in `.env`.

You can generate, review, and keep MP4s locally with no YouTube connection. Connect a channel only when you want the publisher to upload.

Do not commit `config/credentials.json` or `config/tokens.json`.

## What you will create

| Piece | What it is | Stored where |
| --- | --- | --- |
| OAuth Client ID | Ends in `.apps.googleusercontent.com` | `config/credentials.json` (via dashboard) |
| OAuth Client Secret | Shown once when you create the client | same file |
| User tokens | Access + refresh after you sign in | `config/tokens.json` |
| Redirect URI | Where Google sends the auth code | `http://127.0.0.1:<PORT>/api/youtube/callback` |

Default port is `3456`, so the redirect is:

```
http://127.0.0.1:3456/api/youtube/callback
```

If `PORT` in `.env` is different, use that port. The dashboard **Channel setup** panel shows the live URI.

## 1. Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or pick one you already use for this machine).
3. Open [APIs & Services → Library](https://console.cloud.google.com/apis/library).
4. Enable **YouTube Data API v3**.
5. Optional for analytics learning: enable **YouTube Analytics API**.

## 2. OAuth consent screen

1. Open [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent).
2. User type: **External**.
3. App name and support email: anything you will recognize (this app is only on your computer).
4. Publishing status can stay **Testing**.
5. Under **Test users**, add the Google account that owns the YouTube channel (the Gmail you will click in the sign-in window).

If that email is not a test user, Google returns **`403 access_denied`**.

Scopes this agent requests:

- `https://www.googleapis.com/auth/youtube.upload`
- `https://www.googleapis.com/auth/youtube`
- `https://www.googleapis.com/auth/youtube.readonly`
- `https://www.googleapis.com/auth/yt-analytics.readonly`

You do not add these by hand in Cloud Console for a Desktop client; they appear when the user consents.

## 3. OAuth client

1. Open [Credentials](https://console.cloud.google.com/apis/credentials).
2. **Create credentials → OAuth client ID**.
3. Application type: **Desktop app** (not Web application, not API key).
4. Name it e.g. `Lumen local`.
5. Create, then copy **Client ID** and **Client Secret**.

For a Desktop client, Google may not show a redirect-URI field. The agent still uses `http://127.0.0.1:3456/api/youtube/callback`. If you instead created a **Web** client, add that exact URI under Authorized redirect URIs.

## 4. Connect in the dashboard

1. `npm start` and open [http://localhost:3456](http://localhost:3456).
2. Go to **Channel setup**.
3. Paste Client ID and Client Secret.
4. **Save YouTube client**.
5. **Connect Google account**. A browser window opens.
6. Sign in as the **test user**.
7. If you see **Google hasn’t verified this app**, that is normal for a local unpublished client. Use **Advanced → Go to … (unsafe)** / Continue.
8. Allow the YouTube scopes. The tab should say **YouTube connected**. Return to Channel setup; status should be connected.

`npm run walkthrough` can run the same Google sign-in from the terminal.

To sign out: **Disconnect** on Channel setup. That deletes `config/tokens.json` YouTube tokens. The client id/secret stay until you overwrite them.

## 5. Files on disk

After a successful connect:

```
config/credentials.json   # youtube.client_id, youtube.client_secret, redirect_uris
config/tokens.json        # youtube access_token, refresh_token, expiry
```

Templates (safe to commit): [`config/credentials.example.json`](../config/credentials.example.json).

You can also write the client into `credentials.json` by hand, then only use **Connect Google account**. Client ID must end with `.apps.googleusercontent.com`.

## Publishing after connect

- Approve a video in Review Studio (facts + rights + privacy).
- Default privacy is **`private`** (`DEFAULT_PRIVACY_STATUS` in `.env`). It will not appear on the public channel until you change it in YouTube Studio.
- The publisher cron runs **every 15 minutes**, not at the exact minute on the calendar.
- YouTube rejects `publishAt` if that time is already in the past (**invalid scheduled publishing time**). Wait for the next tick or upload without a past schedule.
- Custom thumbnails and captions can fail with permission/scope errors even when the video upload succeeded. Enable custom thumbnails on the channel if you need them.

## Troubleshooting

| Error or symptom | Fix |
| --- | --- |
| `403 access_denied` | Add that Gmail as an OAuth **test user** |
| App not verified | Continue / Advanced — expected in Testing |
| Redirect / `redirect_uri_mismatch` | URI must be exactly `http://127.0.0.1:<PORT>/api/youtube/callback` (127.0.0.1, not `localhost`) |
| Save client rejected | ID must end in `.apps.googleusercontent.com` |
| Connect says save client first | Save ID + secret, then connect |
| Generation works, upload does not | YouTube still **Not connected** — finish sign-in |
| Uploaded but not on the channel | Privacy is **private** — open Studio |
| Invalid scheduled publishing time | Slot already passed; see [README publishing](../README.md#automation-and-publishing) |
| Quota exceeded | [Google Cloud quotas](https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas) |
| Tokens stop working | Disconnect and connect again (`prompt=consent` requests a new refresh token) |

## API equivalents

```bash
curl http://localhost:3456/api/youtube

curl -X PUT http://localhost:3456/api/youtube \
  -H "Content-Type: application/json" \
  -d '{"clientId":"...apps.googleusercontent.com","clientSecret":"..."}'

curl -X POST http://localhost:3456/api/youtube/connect
# open the returned authUrl, then Google hits GET /api/youtube/callback?code=...

curl -X POST http://localhost:3456/api/youtube/disconnect
```

If `API_KEY` is set in `.env`, send `x-api-key` on PUT/POST.

## What not to commit

`.env` does not hold YouTube OAuth. Never commit:

- `config/credentials.json`
- `config/tokens.json`
- Screen recordings of the consent page that show the secret

The public repo should only have `credentials.example.json` and this guide.
