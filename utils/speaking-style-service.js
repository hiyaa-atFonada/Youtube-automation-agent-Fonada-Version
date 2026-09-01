'use strict';

const path = require('path');
const { Logger } = require('./logger');
const { AITextService } = require('./ai-text-service');
const { downloadYouTubeAudio, normalizeYouTubeUrl, parseYouTubeId, streamYouTubeAudio } = require('./youtube-audio');
const { resolveAsrLanguage, transcribeAudioBufferRest, transcribeAudioFile, transcribeAudioStream } = require('./fonada-asr');
const { detectLanguageFromText } = require('./fonada-tts');

const DEFAULT_AUDIO_DIR = path.join(__dirname, '..', 'data', 'audio', 'style-sources');
const EXCERPT_LIMIT = 420;

class SpeakingStyleService {
  constructor(db, credentials = {}) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('SpeakingStyle');
    this.aiTextService = new AITextService(credentials?.credentials || credentials || {});
  }

  async ingestYouTubeVideos(urls, options = {}) {
    const unique = this.normalizeInputs(urls).slice(0, options.limit || 5);
    if (unique.length === 0) {
      throw new Error('Provide 1–5 YouTube video links to learn a speaking style');
    }

    const sources = [];
    for (const [index, item] of unique.entries()) {
      this.logger.info(`Ingesting ${item.url}`);
      if (typeof options.onProgress === 'function') {
        options.onProgress(`Transcribing video ${index + 1} of ${unique.length}…`);
      }
      const source = options.saveAudio
        ? await this.ingestSavedAudio(item, options)
        : await this.ingestStreamingAudio(item, options);
      if (this.db?.saveSpeakingStyleSource) {
        await this.db.saveSpeakingStyleSource(source);
      }
      sources.push(source);
    }

    const profile = await this.buildProfile(sources, options);
    if (this.db?.saveSpeakingStyleProfile) {
      await this.db.saveSpeakingStyleProfile(profile);
    }
    return { sources, profile };
  }

  normalizeInputs(urls = []) {
    const seen = new Set();
    const items = [];
    for (const input of urls) {
      const url = normalizeYouTubeUrl(input);
      const videoId = parseYouTubeId(input);
      if (!url || !videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      items.push({ url, videoId });
    }
    return items;
  }

  async ingestStreamingAudio(item, options = {}) {
    let streamed;
    try {
      streamed = await streamYouTubeAudio(item.url, {
        maxMinutes: options.maxMinutes,
        full: options.full,
        cookiesPath: options.cookiesPath
      });
    } catch (error) {
      this.logger.warn(`Live audio stream failed for ${item.videoId} (${error.message}). Downloading a temp MP3 instead.`);
      return this.ingestSavedAudio(item, options);
    }
    try {
      const transcript = streamed.audioBuffer
        ? await transcribeAudioBufferRest(streamed.audioBuffer, {
          apiKey: options.apiKey,
          language: options.language
        })
        : await transcribeAudioStream(streamed.stream, {
          apiKey: options.apiKey,
          language: options.language
        });
      return {
        videoId: streamed.videoId,
        url: streamed.url,
        title: streamed.title,
        language: transcript.language,
        transcript: transcript.text,
        excerpt: excerptTranscript(transcript.text),
        durationSeconds: transcript.durationSeconds,
        creditsUsed: transcript.creditsUsed,
        transport: transcript.transport || 'websocket'
      };
    } finally {
      streamed.close();
    }
  }

  async ingestSavedAudio(item, options = {}) {
    const downloaded = await downloadYouTubeAudio(item.url, options.outputDir || DEFAULT_AUDIO_DIR, {
      maxMinutes: options.maxMinutes,
      full: options.full,
      cookiesPath: options.cookiesPath
    });
    const transcript = await transcribeAudioFile(downloaded.audioPath, {
      apiKey: options.apiKey,
      language: options.language
    });
    return {
      videoId: downloaded.videoId,
      url: downloaded.url,
      title: downloaded.title,
      language: transcript.language,
      transcript: transcript.text,
      excerpt: excerptTranscript(transcript.text),
      durationSeconds: transcript.durationSeconds,
      creditsUsed: transcript.creditsUsed,
      audioPath: downloaded.audioPath
    };
  }

  async buildProfile(sources, options = {}) {
    const heuristic = buildHeuristicProfile(sources);
    if (!this.aiTextService.isAvailable()) {
      this.logger.warn('No language model configured — saving a heuristic speaking-style profile from transcripts');
      return heuristic;
    }

    try {
      const language = resolveAsrLanguage(options.language, sources.map(source => source.transcript).join('\n'));
      const prompt = buildStyleExtractionPrompt(sources, language);
      const response = await this.aiTextService.generateText(prompt, { maxTokens: 900, temperature: 0.3 });
      const parsed = parseJsonObject(response);
      return {
        ...heuristic,
        ...normalizeExtractedProfile(parsed),
        source: 'fonada-asr+llm',
        provider: this.aiTextService.providerName,
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      this.logger.warn(`Style extraction via LLM failed; using transcript heuristics: ${error.message}`);
      return heuristic;
    }
  }
}

function excerptTranscript(text, limit = EXCERPT_LIMIT) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trim()}…`;
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?।|])\s+/)
    .map(part => part.trim())
    .filter(Boolean);
}

function averageSentenceWords(sentences) {
  if (!sentences.length) return 0;
  const words = sentences.reduce((sum, sentence) => sum + sentence.split(/\s+/).length, 0);
  return Number((words / sentences.length).toFixed(1));
}

function detectMix(text) {
  const language = detectLanguageFromText(text);
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const other = (text.match(/[^\x00-\x7F]/g) || []).length;
  if (language.iso !== 'en' && latin > 20 && other > 20) {
    return `${language.name}/English mix`;
  }
  return language.name;
}

function buildHeuristicProfile(sources = []) {
  const allText = sources.map(source => source.transcript).filter(Boolean).join('\n');
  const sentences = sources.flatMap(source => splitSentences(source.transcript));
  const openings = sources.map(source => splitSentences(source.transcript)[0]).filter(Boolean).slice(0, 5);
  const closings = sources.map(source => {
    const parts = splitSentences(source.transcript);
    return parts[parts.length - 1];
  }).filter(Boolean).slice(0, 5);

  return {
    enabled: true,
    openingStyle: openings[0] || '',
    sentenceRhythm: averageSentenceWords(sentences) <= 12 ? 'short punchy sentences' : 'longer explanatory sentences',
    averageSentenceWords: averageSentenceWords(sentences),
    vocabulary: detectMix(allText),
    catchphrases: openings.slice(0, 3),
    ctaStyle: closings[0] || '',
    energy: 'inferred from recent videos',
    sampleExcerpts: sources.map(source => ({
      title: source.title,
      url: source.url,
      excerpt: source.excerpt
    })),
    sourceVideoCount: sources.length,
    source: 'heuristic',
    updatedAt: new Date().toISOString()
  };
}

function buildStyleExtractionPrompt(sources, language) {
  const blocks = sources.map((source, index) => {
    return `Video ${index + 1}: ${source.title || source.videoId}\n${excerptTranscript(source.transcript, 900)}`;
  }).join('\n\n');

  return `You are extracting a YouTube creator's speaking style from ASR transcripts.
Return only valid JSON with this exact shape:
{
  "openingStyle": "how they usually start a video",
  "sentenceRhythm": "short punchy vs long explanatory",
  "vocabulary": "jargon level and language mix",
  "catchphrases": ["repeated phrases"],
  "ctaStyle": "how they ask for subscribe/like/comment",
  "energy": "calm teacher vs high-energy host",
  "dos": ["things a script should copy"],
  "donts": ["generic AI habits to avoid"]
}

Write the analysis in ${language === 'hi' ? 'Hindi or Hinglish if the transcripts are Hindi' : 'the transcript language'}.
Do not invent facts that are not in the transcripts.

Transcripts:
${blocks}`;
}

function parseJsonObject(response) {
  const text = String(response || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw error;
    return JSON.parse(match[0]);
  }
}

function normalizeExtractedProfile(parsed = {}) {
  return {
    openingStyle: String(parsed.openingStyle || '').trim(),
    sentenceRhythm: String(parsed.sentenceRhythm || '').trim(),
    vocabulary: String(parsed.vocabulary || '').trim(),
    catchphrases: Array.isArray(parsed.catchphrases) ? parsed.catchphrases.map(String).slice(0, 8) : [],
    ctaStyle: String(parsed.ctaStyle || '').trim(),
    energy: String(parsed.energy || '').trim(),
    dos: Array.isArray(parsed.dos) ? parsed.dos.map(String).slice(0, 6) : [],
    donts: Array.isArray(parsed.donts) ? parsed.donts.map(String).slice(0, 6) : []
  };
}

function formatSpeakingStyleForPrompt(profile) {
  if (!profile || profile.enabled === false) return '';

  const lines = [
    'Speak like this creator, not like generic YouTube AI.',
    profile.openingStyle && `Opening style: ${profile.openingStyle}`,
    profile.sentenceRhythm && `Sentence rhythm: ${profile.sentenceRhythm}`,
    profile.vocabulary && `Vocabulary: ${profile.vocabulary}`,
    profile.catchphrases?.length && `Catchphrases: ${profile.catchphrases.join('; ')}`,
    profile.ctaStyle && `CTA style: ${profile.ctaStyle}`,
    profile.energy && `Energy: ${profile.energy}`,
    profile.dos?.length && `Do: ${profile.dos.join('; ')}`,
    profile.donts?.length && `Don't: ${profile.donts.join('; ')}`
  ].filter(Boolean);

  const excerpts = (profile.sampleExcerpts || [])
    .slice(0, 3)
    .map(item => `- ${item.title || 'video'}: ${item.excerpt}`)
    .join('\n');
  if (excerpts) {
    lines.push(`Transcript excerpts:\n${excerpts}`);
  }

  return lines.join('\n');
}

async function attachSpeakingStyle(strategy, db) {
  if (!db?.getSpeakingStyleProfile) return strategy;
  const enabled = await db.getSetting('speaking_style_enabled');
  if (enabled === 'false') return strategy;
  const profile = await db.getSpeakingStyleProfile();
  if (profile) {
    strategy.speakingStyleProfile = profile;
  }
  return strategy;
}

module.exports = {
  SpeakingStyleService,
  attachSpeakingStyle,
  buildHeuristicProfile,
  buildStyleExtractionPrompt,
  excerptTranscript,
  formatSpeakingStyleForPrompt
};
