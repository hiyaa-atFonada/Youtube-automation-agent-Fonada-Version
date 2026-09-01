# Fonada credentials

Fonada provides **TTS narration** and **ASR** for speaking-style learning. Generation still runs without it (Gemini, OpenAI, or silent video), but Fonada is the primary voice path.

Do not commit API keys or share ids. Put them in `.env` (gitignored) or Channel setup.

## What you need

| Item | Required for | Where it goes |
| --- | --- | --- |
| API key | TTS and ASR | `FONADA_API_KEY` in `.env` |
| Voice name **or** `share_id` | How the host sounds | Channel setup **Voice or share id**, or `FONADA_VOICE` / `FONADA_SHARE_ID` |
| Spoken language | Script + TTS + ASR | Dashboard dropdowns, not `.env` |

Create an account and key at [fonada.ai](https://fonada.ai).

## Add the API key

```bash
cp .env.example .env
```

Uncomment and set:

```env
FONADA_API_KEY=your-fonada-api-key-here
```

Optional:

```env
FONADA_VOICE=Dhruv
FONADA_SHARE_ID=abc12xyz
FONADA_TTS_MODEL=v1
```

- `FONADA_TTS_MODEL=v1` forces catalog voices even if a share id is present.
- `FONADA_TTS_MODEL=klone-v2` (or omit / `auto`) uses Klone when a share id is available.
- `FONADA_LANGUAGE` is not used for generation. Language comes from **Create video** and Channel setup.

You can also store Fonada settings in `config/credentials.json` (`fonada.apiKey`, `fonada.shareId`, `fonada.voice`, `fonada.model`). Prefer `.env` plus the dashboard so secrets stay out of git.

Restart `npm start` after changing `.env`.

## Voice or share id

In **Channel setup** and **Create video**, **Voice or share id** is parsed as follows:

| What you type | Result |
| --- | --- |
| 6–12 characters, letters **and** digits (e.g. `abc12xyz`) | Klone V2 clone (`POST /v1/voice-clone/chunks` with `share_id`) |
| A catalog name (`Dhruv`, `Vaanee`, `Vaani`) | Fonada V1 TTS |
| `clone` | Uses `FONADA_SHARE_ID` from `.env` |
| `v1:Dhruv` | Force V1 |
| `v2:…` or an id containing `@` | Klone catalog voice |
| Blank | `FONADA_SHARE_ID` if set, otherwise V1 default for the language |

A Fonada **catalog voice id** is not a `share_id`. Klone clone needs the share id from **your** cloned voice in the Fonada dashboard.

V1 names by language (defaults in parentheses):

- English / Hindi — Dhruv, Vaanee, Swastik, Laksh, and others (default **Dhruv**)
- Tamil — Vaani, Isai, Thalam, … (default **Vaani**)
- Telugu — Ansh, Dhruv, Aadhira, … (default **Naadamu**)

Klone V2 can speak more Indic languages than V1. The dashboard language list for scripts is Hindi, English, Tamil, and Telugu; the TTS layer understands additional ISO codes if you set them via API.

## Spoken language

Set language in the UI:

- **Channel setup → Spoken language** — default for new jobs
- **Create video → Spoken language** — that job only
- **Speaking style → Spoken language for ASR** — transcription language

Match ASR to the language **spoken on the video**. English speech with Hindi ASR writes English sounds in Devanagari.

## Speaking style (ASR)

Speaking style uses the same `FONADA_API_KEY`. It transcribes YouTube audio (`https://api.fonada.ai/v2/asr/transcribe` and/or `wss://api.fonada.ai/v1/asr/stream`).

Also required on the machine:

- `yt-dlp` on `PATH`, or `YT_DLP_PATH`
- Optional `YT_DLP_COOKIES` if YouTube blocks anonymous audio download

This does **not** clone a voice. It only feeds delivery notes into the next scripts.

```bash
npm run test:fonada-asr
npm run test:fonada
```

## Check that it loaded

On `npm start`, the capability list should show **Voice narration (TTS)** as OK when `FONADA_API_KEY` (or another TTS key) is set.

If Fonada is missing, narration falls back: Gemini TTS → OpenAI TTS → ElevenLabs → Azure → silent/simulated.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Silent or simulated video | `FONADA_API_KEY` in `.env`, then restart |
| Clone API errors / wrong voice | You pasted a catalog id; need the Klone **share_id** |
| Always V1 | `FONADA_TTS_MODEL=v1`, or the field looks like a name, not a share id |
| ASR empty / download timeout | `yt-dlp`, cookies, and that the link is a single watch URL |
| Rate limit (429) | The agent retries a few times; wait and run fewer jobs |
| Key in `.env` but ignored | File is `youtube-automation-agent/.env`, not a copy in another folder |

## What not to commit

`.env`, `config/credentials.json`, and anything under `data/audio/` (style sources, test clips). [`.env.example`](../.env.example) is the public template.
