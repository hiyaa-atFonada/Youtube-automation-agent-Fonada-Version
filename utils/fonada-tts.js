'use strict';

const axios = require('axios');

const FONADA_API_BASE = 'https://api.fonada.ai';
const FONADA_V1_ENDPOINT = `${FONADA_API_BASE}/tts/generate-audio-large`;
const FONADA_CLONE_ENDPOINT = `${FONADA_API_BASE}/v1/voice-clone/chunks`;
const FONADA_V2_VOICES_ENDPOINT = `${FONADA_API_BASE}/v2/voices`;

const V1_VOICES_BY_LANGUAGE = {
  English: ['Dhruv', 'Vaanee', 'Swastik', 'Laksh', 'Raag', 'Sarvagya', 'Komal', 'Meghra', 'Pancham', 'Tara', 'Sharad', 'Kritika', 'Mandra', 'Karn', 'Gauri', 'Ruhi', 'Roshini', 'Parikshit'],
  Hindi: ['Dhruv', 'Vaanee', 'Swastik', 'Laksh', 'Raag', 'Sarvagya', 'Komal', 'Meghra', 'Pancham', 'Tara', 'Sharad', 'Kritika', 'Mandra', 'Karn', 'Gauri', 'Ruhi', 'Roshini', 'Parikshit'],
  Tamil: ['Vaani', 'Isai', 'Thalam', 'Swaram', 'Madhuri', 'Naadham', 'Rachna', 'Pallavi', 'Mrityunjay', 'Malika', 'Yamini', 'Tilak', 'Dhruv', 'Sanket', 'Rudraksh'],
  Telugu: ['Ansh', 'Dhruv', 'Aadhira', 'Aahana', 'Aakriti', 'Ridhima', 'Vaani', 'Shaury', 'Bhavyaa', 'Tanuj', 'Utkarsh', 'Adyaa', 'Raagini', 'Kanika', 'Madhav', 'Malini', 'Priya', 'Mala', 'Dhairy', 'Shruti', 'Tara', 'Shubhra', 'Mandara', 'Tanya', 'Sara', 'Rudrika', 'Ruhi', 'Sameer', 'Geetika', 'Naitik', 'Kartik']
};

const voiceCatalogCache = { expiresAt: 0, value: null };

const V1_MAX_CHARS = 420;
const CLONE_MAX_CHARS = 400;

const FONADA_TTS_LANGUAGES = [
  { iso: 'hi', name: 'Hindi', v1: 'Hindi', v1Supported: true, voice: 'Dhruv' },
  { iso: 'en', name: 'English', v1: 'English', v1Supported: true, voice: 'Dhruv' },
  { iso: 'as', name: 'Assamese', v1: 'Assamese', v1Supported: false },
  { iso: 'bn', name: 'Bengali', v1: 'Bengali', v1Supported: false },
  { iso: 'brx', name: 'Bodo', v1: 'Bodo', v1Supported: false },
  { iso: 'doi', name: 'Dogri', v1: 'Dogri', v1Supported: false },
  { iso: 'gu', name: 'Gujarati', v1: 'Gujarati', v1Supported: false },
  { iso: 'kn', name: 'Kannada', v1: 'Kannada', v1Supported: false },
  { iso: 'ks', name: 'Kashmiri', v1: 'Kashmiri', v1Supported: false },
  { iso: 'kok', name: 'Konkani', v1: 'Konkani', v1Supported: false },
  { iso: 'mai', name: 'Maithili', v1: 'Maithili', v1Supported: false },
  { iso: 'ml', name: 'Malayalam', v1: 'Malayalam', v1Supported: false },
  { iso: 'mni', name: 'Manipuri', v1: 'Manipuri', v1Supported: false },
  { iso: 'mr', name: 'Marathi', v1: 'Marathi', v1Supported: false },
  { iso: 'ne', name: 'Nepali', v1: 'Nepali', v1Supported: false },
  { iso: 'or', name: 'Odia', v1: 'Odia', v1Supported: false },
  { iso: 'pa', name: 'Punjabi', v1: 'Punjabi', v1Supported: false },
  { iso: 'sa', name: 'Sanskrit', v1: 'Sanskrit', v1Supported: false },
  { iso: 'sat', name: 'Santali', v1: 'Santali', v1Supported: false },
  { iso: 'sd', name: 'Sindhi', v1: 'Sindhi', v1Supported: false },
  { iso: 'ta', name: 'Tamil', v1: 'Tamil', v1Supported: true, voice: 'Vaani' },
  { iso: 'te', name: 'Telugu', v1: 'Telugu', v1Supported: true, voice: 'Naadamu' },
  { iso: 'ur', name: 'Urdu', v1: 'Urdu', v1Supported: false }
];

const CONTENT_LANGUAGE_CHOICES = FONADA_TTS_LANGUAGES.map(({ iso, name }) => ({ iso, name }));
const CONTENT_LANGUAGE_ISOS = new Set(FONADA_TTS_LANGUAGES.map(language => language.iso));
const DEFAULT_VOICES = Object.fromEntries(
  FONADA_TTS_LANGUAGES
    .filter(language => language.voice)
    .map(language => [language.v1, language.voice])
);
DEFAULT_VOICES.English = DEFAULT_VOICES.English || 'Dhruv';

function normalizeLanguageKey(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

const LANGUAGE_ALIASES = {};
for (const language of FONADA_TTS_LANGUAGES) {
  const record = {
    v1: language.v1,
    iso: language.iso,
    name: language.name,
    v1Supported: Boolean(language.v1Supported)
  };
  LANGUAGE_ALIASES[language.iso] = record;
  LANGUAGE_ALIASES[normalizeLanguageKey(language.name)] = record;
  LANGUAGE_ALIASES[`${language.iso}-in`] = record;
}
LANGUAGE_ALIASES['en-us'] = LANGUAGE_ALIASES.en;
LANGUAGE_ALIASES.bangla = LANGUAGE_ALIASES.bn;
LANGUAGE_ALIASES.oriya = LANGUAGE_ALIASES.or;

const SCRIPT_DETECTORS = [
  { language: 'Hindi', pattern: /[\u0900-\u097F]/g },
  { language: 'Bengali', pattern: /[\u0980-\u09FF]/g },
  { language: 'Punjabi', pattern: /[\u0A00-\u0A7F]/g },
  { language: 'Gujarati', pattern: /[\u0A80-\u0AFF]/g },
  { language: 'Odia', pattern: /[\u0B00-\u0B7F]/g },
  { language: 'Tamil', pattern: /[\u0B80-\u0BFF]/g },
  { language: 'Telugu', pattern: /[\u0C00-\u0C7F]/g },
  { language: 'Kannada', pattern: /[\u0C80-\u0CFF]/g },
  { language: 'Malayalam', pattern: /[\u0D00-\u0D7F]/g },
  { language: 'Urdu', pattern: /[\u0600-\u06FF]/g }
];

function lookupLanguage(value) {
  const key = normalizeLanguageKey(value);
  if (!key) return null;
  if (LANGUAGE_ALIASES[key]) return { ...LANGUAGE_ALIASES[key] };

  const iso = key.split('-')[0];
  if (LANGUAGE_ALIASES[iso]) return { ...LANGUAGE_ALIASES[iso] };

  if (/^[a-z]{2,3}$/.test(iso)) {
    return {
      v1: 'English',
      iso,
      name: iso,
      v1Supported: false
    };
  }

  return null;
}

function countMatches(text, pattern) {
  const matches = String(text || '').match(pattern);
  return matches ? matches.length : 0;
}

function detectLanguageFromText(text) {
  let best = null;
  let bestCount = 0;

  for (const detector of SCRIPT_DETECTORS) {
    const count = countMatches(text, detector.pattern);
    if (count > bestCount) {
      best = detector.language;
      bestCount = count;
    }
  }

  if (bestCount === 0) {
    return lookupLanguage('English');
  }

  return lookupLanguage(best);
}

function resolveFonadaLanguage({ explicit, text, fallback } = {}) {
  const detected = detectLanguageFromText(text);
  if (detected && detected.iso !== 'en') {
    return detected;
  }

  return lookupLanguage(explicit)
    || detected
    || lookupLanguage(fallback)
    || lookupLanguage('English');
}

function resolveContentLanguage(source = {}) {
  return resolveFonadaLanguage({
    explicit: source.language || source.contentLanguage,
    text: source.text,
    fallback: source.fallback || 'English'
  });
}

function normalizeContentLanguage(value) {
  const resolved = lookupLanguage(value);
  if (!resolved || !CONTENT_LANGUAGE_ISOS.has(resolved.iso)) return null;
  return resolved;
}

function defaultVoiceForLanguage(language) {
  const resolved = lookupLanguage(language?.v1 || language?.name || language) || lookupLanguage('English');
  return DEFAULT_VOICES[resolved.v1] || DEFAULT_VOICES.English;
}

function splitOversizedSegment(segment, maxChars) {
  const pieces = [];
  const parts = String(segment).split(/(\s+)/);
  let current = '';

  for (const part of parts) {
    if (!part) continue;
    if ((current + part).length <= maxChars) {
      current += part;
      continue;
    }
    if (current.trim()) pieces.push(current.trim());
    if (part.trim().length > maxChars) {
      for (let i = 0; i < part.length; i += maxChars) {
        pieces.push(part.slice(i, i + maxChars));
      }
      current = '';
    } else {
      current = part.trimStart();
    }
  }

  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function chunkTextForTTS(text, maxChars = V1_MAX_CHARS) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const sentences = normalized.split(/(?<=[.!?।|])\s+/);
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      chunks.push(...splitOversizedSegment(sentence, maxChars));
      continue;
    }

    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length <= maxChars) {
      current = next;
    } else {
      chunks.push(current.trim());
      current = sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function parseFonadaError(data, status) {
  if (data == null) return `Fonada TTS failed with HTTP ${status || 'unknown'}`;

  let parsed = data;
  if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
    const text = Buffer.from(data).toString('utf8');
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return text.slice(0, 300) || `Fonada TTS failed with HTTP ${status || 'unknown'}`;
    }
  }

  const detail = parsed?.detail;
  if (typeof detail === 'string') return detail;
  if (detail?.message) return detail.message;
  if (parsed?.message) return parsed.message;
  if (parsed?.error) return String(parsed.error);
  return `Fonada TTS failed with HTTP ${status || 'unknown'}`;
}

function isKloneModel(model) {
  const value = String(model || '').trim().toLowerCase();
  return value === 'klone-v2' || value === 'klone' || value === 'v2';
}

function isV1OnlyModel(model) {
  const value = String(model || '').trim().toLowerCase();
  return value === 'v1' || value === 'fonada-v1';
}

function voiceKey(value) {
  return String(value || '').trim();
}

function buildCloneVoiceOption(shareId) {
  if (!shareId) return null;
  return {
    id: 'clone',
    source: 'clone',
    name: 'My cloned voice',
    voiceId: shareId,
    languages: CONTENT_LANGUAGE_CHOICES.map(language => language.iso),
    label: 'My cloned voice · Klone V2'
  };
}

function buildV2VoiceOption(voice = {}) {
  const voiceId = voiceKey(voice.id || voice.voiceId);
  if (!voiceId) return null;
  const language = lookupLanguage(voice.language);
  const name = voiceKey(voice.display_name || voice.name || voiceId.split('@')[0]);
  const gender = voiceKey(voice.gender);
  return {
    id: `v2:${voiceId}`,
    source: 'klone-v2',
    name,
    voiceId,
    language: language?.name || voice.language || null,
    iso: language?.iso || null,
    gender: gender || null,
    enabled: voice.enabled !== false,
    label: `${name}${language ? ` · ${language.name}` : ''}${gender ? ` · ${gender}` : ''} · Klone V2`
  };
}

function buildV1VoiceOptions() {
  const byName = new Map();
  for (const [languageName, names] of Object.entries(V1_VOICES_BY_LANGUAGE)) {
    const language = lookupLanguage(languageName);
    if (!language) continue;
    for (const name of names) {
      const current = byName.get(name) || {
        id: `v1:${name}`,
        source: 'v1',
        name,
        voiceId: name,
        languages: [],
        label: ''
      };
      if (!current.languages.includes(language.iso)) current.languages.push(language.iso);
      byName.set(name, current);
    }
  }
  return [...byName.values()].map(voice => ({
    ...voice,
    label: `${voice.name} · ${voice.languages.map(iso => lookupLanguage(iso)?.name).filter(Boolean).join('/')} · Fonada V1`
  }));
}

function normalizeFonadaVoicesPayload(payload = {}) {
  const voices = Array.isArray(payload.voices) ? payload.voices : [];
  return voices
    .map(buildV2VoiceOption)
    .filter(voice => voice && voice.enabled !== false);
}

async function fetchFonadaV2Voices(apiKey) {
  if (!apiKey) return [];
  const response = await axios.get(FONADA_V2_VOICES_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    },
    timeout: 15000,
    validateStatus: () => true
  });
  if (response.status >= 400) {
    throw new Error(parseFonadaError(response.data, response.status));
  }
  return normalizeFonadaVoicesPayload(response.data);
}

async function listFonadaVoices({ apiKey, shareId } = {}) {
  const now = Date.now();
  if (voiceCatalogCache.value && voiceCatalogCache.expiresAt > now) {
    return voiceCatalogCache.value;
  }

  let v2 = [];
  let error = null;
  if (apiKey) {
    try {
      v2 = await fetchFonadaV2Voices(apiKey);
    } catch (fetchError) {
      error = fetchError.message;
    }
  }

  const voices = [
    buildCloneVoiceOption(shareId),
    ...v2,
    ...buildV1VoiceOptions()
  ].filter(Boolean);

  const catalog = {
    voices,
    defaultVoice: v2[0]?.id || (shareId ? 'clone' : 'v1:Dhruv'),
    fetchedAt: new Date().toISOString(),
    error
  };
  voiceCatalogCache.value = catalog;
  voiceCatalogCache.expiresAt = now + 10 * 60 * 1000;
  return catalog;
}

function normalizeFonadaVoice(value, catalog = []) {
  const raw = voiceKey(value);
  if (!raw) return null;
  const voices = Array.isArray(catalog) ? catalog : catalog?.voices || [];
  return voices.find(voice =>
    voice.id === raw
    || voice.voiceId === raw
    || voice.name.toLowerCase() === raw.toLowerCase()
  ) || null;
}

function looksLikeShareId(value) {
  return /^[A-Za-z0-9]{6,12}$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

function parseTypedVoice(value) {
  const raw = voiceKey(value);
  if (!raw) return null;
  if (raw === 'clone') {
    return { id: 'clone', source: 'clone', name: 'My cloned voice', voiceId: raw };
  }
  if (raw.startsWith('v1:')) {
    const name = raw.slice(3).trim();
    return name ? { id: raw, source: 'v1', name, voiceId: name } : null;
  }
  if (raw.startsWith('v2:')) return buildV2VoiceOption({ id: raw.slice(3) });
  if (raw.includes('@')) return buildV2VoiceOption({ id: raw });
  if (looksLikeShareId(raw)) {
    return { id: raw, source: 'clone', name: 'Custom cloned voice', voiceId: raw };
  }
  return { id: `v1:${raw}`, source: 'v1', name: raw, voiceId: raw };
}

function isPlausibleVoiceId(value) {
  const raw = voiceKey(value);
  if (!raw || raw.length > 80) return false;
  if (!/^[A-Za-z0-9@._:\- ]+$/.test(raw)) return false;
  if (!/[A-Za-z]/.test(raw)) return false;
  return Boolean(parseTypedVoice(raw));
}

function isKloneCatalogVoice(voice) {
  return voice?.source === 'klone-v2' || voice?.source === 'clone';
}

module.exports = {
  FONADA_API_BASE,
  FONADA_V1_ENDPOINT,
  FONADA_CLONE_ENDPOINT,
  FONADA_V2_VOICES_ENDPOINT,
  V1_MAX_CHARS,
  CLONE_MAX_CHARS,
  V1_VOICES_BY_LANGUAGE,
  CONTENT_LANGUAGE_CHOICES,
  FONADA_TTS_LANGUAGES,
  DEFAULT_VOICES,
  buildV1VoiceOptions,
  buildV2VoiceOption,
  chunkTextForTTS,
  defaultVoiceForLanguage,
  detectLanguageFromText,
  fetchFonadaV2Voices,
  isKloneCatalogVoice,
  isKloneModel,
  isV1OnlyModel,
  listFonadaVoices,
  lookupLanguage,
  looksLikeShareId,
  normalizeContentLanguage,
  isPlausibleVoiceId,
  normalizeFonadaVoice,
  parseTypedVoice,
  normalizeFonadaVoicesPayload,
  parseFonadaError,
  resolveContentLanguage,
  resolveFonadaLanguage
};
