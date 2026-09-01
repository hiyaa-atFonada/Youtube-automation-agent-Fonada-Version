'use strict';

const fs = require('fs');
const FormData = require('form-data');
const axios = require('axios');
const WebSocket = require('ws');
const { detectLanguageFromText, lookupLanguage, parseFonadaError } = require('./fonada-tts');

const FONADA_ASR_ENDPOINT = 'https://api.fonada.ai/v2/asr/transcribe';
const FONADA_ASR_STREAM = process.env.FONADA_ASR_WS_URL || 'wss://api.fonada.ai/v1/asr/stream';

function resolveAsrLanguage(explicit, text) {
  const chosen = lookupLanguage(explicit);
  if (chosen) return chosen.iso;
  const detected = detectLanguageFromText(text);
  if (detected && detected.iso !== 'en') return detected.iso;
  return 'hi';
}

async function postAsrForm(form, languageId, options = {}) {
  const apiKey = options.apiKey || process.env.FONADA_API_KEY;
  if (!apiKey) {
    throw new Error('FONADA_API_KEY is required for Fonada ASR');
  }

  const response = await axios.post(FONADA_ASR_ENDPOINT, form, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...form.getHeaders()
    },
    timeout: Number(options.timeoutMs || 10 * 60 * 1000),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true
  });

  if (response.status >= 400) {
    throw new Error(parseFonadaError(response.data, response.status));
  }

  const data = response.data || {};
  const text = String(data.text || '').trim();
  if (!text) {
    throw new Error('Fonada ASR returned an empty transcript');
  }

  return {
    text,
    language: data.language || languageId,
    durationSeconds: Number(data.audio_duration_s || 0),
    creditsUsed: Number(data.credits_used || 0),
    chunks: data.transcript_chunks || data.chunk_texts || [],
    jobId: data.job_id || null,
    raw: data,
    transport: 'rest'
  };
}

async function transcribeAudioFile(audioPath, options = {}) {
  const languageId = resolveAsrLanguage(options.language, options.text);
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath));
  form.append('language_id', languageId);
  return postAsrForm(form, languageId, options);
}

async function transcribeAudioBufferRest(audioBuffer, options = {}) {
  const languageId = resolveAsrLanguage(options.language, options.text);
  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'narration.mp3', contentType: 'audio/mpeg' });
  form.append('language_id', languageId);
  return postAsrForm(form, languageId, options);
}

function waitForJson(ws, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fonada streaming ASR timed out waiting for a message')), timeoutMs);
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      try {
        resolve(JSON.parse(String(data)));
      } catch (error) {
        reject(new Error(`Fonada streaming ASR returned non-JSON: ${String(data).slice(0, 200)}`));
      }
    };
    const onError = (error) => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      reject(error);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

function openFonadaAsrSocket(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(FONADA_ASR_STREAM);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Could not open Fonada streaming ASR websocket'));
    }, timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function authenticateAsrStream(ws, apiKey, languageId) {
  const welcome = await waitForJson(ws);
  const auth = { api_key: apiKey, language: languageId };
  ws.send(JSON.stringify(auth));
  const response = await waitForJson(ws);
  if (response.status !== 'authenticated') {
    throw new Error(response.message || welcome.message || 'Fonada streaming ASR authentication failed');
  }
}

async function transcribeAudioBuffer(audioBuffer, options = {}) {
  const apiKey = options.apiKey || process.env.FONADA_API_KEY;
  if (!apiKey) {
    throw new Error('FONADA_API_KEY is required for Fonada ASR');
  }
  const languageId = resolveAsrLanguage(options.language, options.text);
  const ws = await openFonadaAsrSocket();
  try {
    await authenticateAsrStream(ws, apiKey, languageId);
    ws.send(audioBuffer);
    const result = await waitForJson(ws, options.timeoutMs || 10 * 60 * 1000);
    if (result.status === 'error' || result.error) {
      throw new Error(result.message || result.error || 'Fonada streaming ASR failed');
    }
    const text = String(result.text || '').trim();
    if (!text) {
      throw new Error('Fonada streaming ASR returned an empty transcript');
    }
    return {
      text,
      language: result.language || languageId,
      durationSeconds: Number(result.audio_duration || result.audio_duration_s || 0),
      creditsUsed: Number(result.credits_used || 0),
      chunks: result.transcript_chunks || result.chunk_texts || [],
      jobId: result.job_id || null,
      raw: result,
      transport: 'websocket'
    };
  } finally {
    ws.close();
  }
}

async function transcribeAudioStream(readable, options = {}) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return transcribeAudioBuffer(Buffer.concat(chunks), options);
}

module.exports = {
  FONADA_ASR_ENDPOINT,
  FONADA_ASR_STREAM,
  resolveAsrLanguage,
  transcribeAudioBuffer,
  transcribeAudioBufferRest,
  transcribeAudioFile,
  transcribeAudioStream
};
