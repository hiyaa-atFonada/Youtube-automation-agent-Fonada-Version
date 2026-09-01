'use strict';

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./logger');
const { getFFmpegPath, runFFmpeg } = require('./ffmpeg');

const execFileAsync = promisify(execFile);
const logger = new Logger('YouTubeAudio');

function parseYouTubeId(input) {
  const value = String(input || '').trim();
  if (!value) return null;

  if (/^[A-Za-z0-9_-]{11}$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const watchId = url.searchParams.get('v');
      if (watchId && /^[A-Za-z0-9_-]{11}$/.test(watchId)) return watchId;
      const parts = url.pathname.split('/').filter(Boolean);
      if (['shorts', 'embed', 'live', 'v'].includes(parts[0]) && /^[A-Za-z0-9_-]{11}$/.test(parts[1] || '')) {
        return parts[1];
      }
    }
  } catch (error) {
    return null;
  }

  return null;
}

function normalizeYouTubeUrl(input) {
  const id = parseYouTubeId(input);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

async function resolveYtDlp() {
  if (process.env.YT_DLP_PATH) {
    return process.env.YT_DLP_PATH;
  }

  const bundled = path.join(__dirname, '..', 'scripts', 'bin', 'yt-dlp');
  for (const command of [bundled, 'yt-dlp', 'youtube-dl']) {
    try {
      await execFileAsync(command, ['--version']);
      return command;
    } catch (error) {
      // try next
    }
  }

  throw new Error(
    'yt-dlp is required to pull audio from YouTube links. Install it with: pip install yt-dlp  (or sudo apt install yt-dlp). Optional: set YT_DLP_PATH.'
  );
}

function ytDlpBaseArgs(options = {}) {
  const args = [
    '--no-playlist',
    '--ignore-config',
    '--no-warnings',
    '-f', 'bestaudio[ext=m4a]/bestaudio/bestaudio*',
    '--extractor-args', 'youtube:player_client=android,tv,web_safari,web'
  ];
  if (options.cookiesPath || process.env.YT_DLP_COOKIES) {
    args.push('--cookies', options.cookiesPath || process.env.YT_DLP_COOKIES);
  }
  return args;
}

function collectProcessError(child, label) {
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  return () => {
    const detail = stderr
      .replace(/\r/g, '\n')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !/^size=/.test(line) && !/Press \[q\]/.test(line))
      .slice(-4)
      .join(' | ');
    return detail ? `${label}: ${detail}` : `${label} failed`;
  };
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function terminateProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    child.kill('SIGTERM');
  } catch (_error) {
    // already gone
  }
  setTimeout(() => {
    if (child.exitCode === null && !child.signalCode) {
      try {
        child.kill('SIGKILL');
      } catch (_error) {
        // already gone
      }
    }
  }, 1500).unref();
}

function formatSectionEnd(maxMinutes) {
  const totalSeconds = Math.max(15, Math.round(Number(maxMinutes) * 60));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

async function streamYouTubeAudio(input, options = {}) {
  const videoId = parseYouTubeId(input);
  const url = normalizeYouTubeUrl(input);
  if (!videoId || !url) {
    throw new Error(`Not a valid YouTube video link: ${input}`);
  }

  const ytDlp = await resolveYtDlp();
  const ffmpeg = getFFmpegPath();
  const maxMinutes = Number(options.maxMinutes || process.env.SPEAKING_STYLE_MAX_MINUTES || 8);
  const timeoutMs = Number(options.timeoutMs || process.env.SPEAKING_STYLE_DOWNLOAD_TIMEOUT_MS || 180000);
  const ffmpegArgs = [
    '-hide_banner', '-loglevel', 'error',
    '-probesize', '10M',
    '-analyzeduration', '10M',
    '-i', 'pipe:0',
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'libmp3lame',
    '-q:a', '5',
    '-f', 'mp3'
  ];
  if (!options.full && Number.isFinite(maxMinutes) && maxMinutes > 0) {
    ffmpegArgs.push('-t', String(Math.round(maxMinutes * 60)));
  }
  ffmpegArgs.push('pipe:1');

  // Do not use --download-sections with stdout: yt-dlp remuxes MPEG-TS
  // (often with video) and this encoder then sees 0 audio bytes.
  const ytArgs = [...ytDlpBaseArgs(options), '--socket-timeout', '20', '-o', '-', url];

  logger.info(`Streaming audio for ${videoId} into Fonada ASR (no video file saved)`);

  const downloader = spawn(ytDlp, ytArgs, {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const encoder = spawn(ffmpeg, ffmpegArgs, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const downloaderError = collectProcessError(downloader, 'yt-dlp');
  const encoderError = collectProcessError(encoder, 'ffmpeg');
  // ffmpeg closes stdin at -t; yt-dlp then gets EPIPE. Swallow pipe errors so they
  // don't crash the whole Node process as an unhandled Socket 'error'.
  const ignoreBrokenPipe = (error) => {
    if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    logger.warn(`YouTube audio pipe: ${error.message}`);
  };
  downloader.stdout.on('error', ignoreBrokenPipe);
  encoder.stdin.on('error', ignoreBrokenPipe);
  downloader.stdout.pipe(encoder.stdin);

  const chunks = [];
  encoder.stdout.on('data', chunk => chunks.push(chunk));
  encoder.stdout.on('error', ignoreBrokenPipe);

  const encodeDone = waitForExit(encoder).then(exit => {
    terminateProcess(downloader);
    return exit;
  });

  let timer;
  try {
    const [downloadExit, encodeExit] = await Promise.race([
      Promise.all([waitForExit(downloader), encodeDone]),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`YouTube audio download timed out for ${videoId} after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      })
    ]);

    const audioBuffer = Buffer.concat(chunks);
    if (encodeExit.code && encodeExit.code !== 0 && audioBuffer.length < 500) {
      throw new Error(encoderError());
    }
    if (downloadExit.code && downloadExit.code !== 0 && audioBuffer.length < 500) {
      throw new Error(downloaderError());
    }
    if (audioBuffer.length < 500 || audioBuffer.slice(0, 3).toString('ascii') !== 'ID3' && audioBuffer[0] !== 0xff) {
      throw new Error(`YouTube audio stream was empty or invalid for ${videoId} (${audioBuffer.length} bytes). ${downloaderError()}`);
    }

    return {
      videoId,
      url,
      title: videoId,
      audioBuffer,
      stream: null,
      close() {}
    };
  } catch (error) {
    terminateProcess(downloader);
    terminateProcess(encoder);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadYouTubeAudio(input, outputDir, options = {}) {
  const videoId = parseYouTubeId(input);
  const url = normalizeYouTubeUrl(input);
  if (!videoId || !url) {
    throw new Error(`Not a valid YouTube video link: ${input}`);
  }

  await fs.mkdir(outputDir, { recursive: true });
  const ytDlp = await resolveYtDlp();
  const maxMinutes = Number(options.maxMinutes || process.env.SPEAKING_STYLE_MAX_MINUTES || 8);
  const template = path.join(outputDir, `${videoId}.%(ext)s`);
  const args = [
    ...ytDlpBaseArgs(options),
    '--socket-timeout', '20',
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '5',
    '-o', template,
    '--print', '%(title)s'
  ];
  if (!options.full && Number.isFinite(maxMinutes) && maxMinutes > 0) {
    args.push('--download-sections', `*0:00-${formatSectionEnd(maxMinutes)}`);
  }
  args.push(url);

  logger.info(`Downloading audio for ${videoId} via ${path.basename(ytDlp)}`);
  const { stdout } = await execFileAsync(ytDlp, args, { maxBuffer: 16 * 1024 * 1024 });
  const title = String(stdout || '').trim().split('\n').filter(Boolean).pop() || videoId;

  const audioPath = path.join(outputDir, `${videoId}.mp3`);
  await fs.access(audioPath);

  if (options.full || !Number.isFinite(maxMinutes) || maxMinutes <= 0) {
    return { videoId, url, title, audioPath, trimmed: false };
  }

  const trimmedPath = path.join(outputDir, `${videoId}-${maxMinutes}m.mp3`);
  await runFFmpeg(['-y', '-i', audioPath, '-t', String(Math.round(maxMinutes * 60)), '-c:a', 'libmp3lame', '-q:a', '5', trimmedPath]);
  return { videoId, url, title, audioPath: trimmedPath, sourceAudioPath: audioPath, trimmed: true, maxMinutes };
}

module.exports = {
  downloadYouTubeAudio,
  normalizeYouTubeUrl,
  parseYouTubeId,
  resolveYtDlp,
  streamYouTubeAudio
};
