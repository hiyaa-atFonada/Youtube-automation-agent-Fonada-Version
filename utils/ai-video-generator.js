const OpenAI = require('openai');
const Replicate = require('replicate');
const FormData = require('form-data');
const fs = require('fs').promises;
const path = require('path');
const { pathToFileURL } = require('url');
const axios = require('axios');
const { Logger } = require('./logger');
const { runFFmpeg, checkFFmpeg, getMediaDuration, ffmpegInstallHint } = require('./ffmpeg');
const {
  FONADA_CLONE_ENDPOINT,
  FONADA_V1_ENDPOINT,
  V1_MAX_CHARS,
  CLONE_MAX_CHARS,
  chunkTextForTTS,
  defaultVoiceForLanguage,
  isKloneCatalogVoice,
  isV1OnlyModel,
  parseFonadaError,
  resolveFonadaLanguage
} = require('./fonada-tts');

function unwrapCredentials(credentials) {
  const nested = credentials?.credentials && typeof credentials.credentials === 'object'
    ? credentials.credentials
    : {};
  return { ...nested, ...(credentials || {}) };
}

class AIVideoGenerator {
  constructor(credentials = {}) {
    this.logger = new Logger('AIVideoGenerator');
    this.lastNarration = null;
    const creds = unwrapCredentials(credentials);
    
    // Initialize AI services with graceful fallback
    const openaiKey = creds.openai?.apiKey || process.env.OPENAI_API_KEY;
    const replicateKey = creds.replicate?.apiKey || process.env.REPLICATE_API_KEY;
    
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.info('OpenAI service initialized');
    } else {
      this.logger.warn('OpenAI API key not found - AI features will be simulated');
    }
    
    if (replicateKey) {
      this.replicate = new Replicate({ auth: replicateKey });
      this.logger.info('Replicate service initialized');
    } else {
      this.logger.warn('Replicate API key not found - advanced video generation unavailable');
    }

    // Gemini media generation (images + native TTS) — free-tier alternative to OpenAI
    const geminiKey = creds.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        this.gemini = new GoogleGenAI({ apiKey: geminiKey });
        this.logger.info('Gemini media service initialized (images + TTS)');
      } catch (error) {
        this.logger.warn('Failed to initialize Gemini media service:', error.message);
      }
    }

    const fonada = creds.fonada || {};
    this.fonadaApiKey = fonada.apiKey || process.env.FONADA_API_KEY;
    this.fonadaVoice = fonada.voice || process.env.FONADA_VOICE;
    this.fonadaLanguage = fonada.language;
    this.fonadaShareId = fonada.shareId || process.env.FONADA_SHARE_ID;
    this.fonadaModel = fonada.model || process.env.FONADA_TTS_MODEL || 'auto';
    
    // Legacy ElevenLabs configuration (kept as a last live fallback)
    this.elevenLabsApiKey = creds.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = creds.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;
    
    // Azure Speech configuration
    this.azureSpeechKey = creds.azure?.speechKey || creds.azureSpeech?.subscriptionKey || process.env.AZURE_SPEECH_KEY;
    this.azureSpeechRegion = creds.azure?.speechRegion || creds.azureSpeech?.region || process.env.AZURE_SPEECH_REGION;

    if (this.fonadaApiKey) {
      this.logger.info('Fonada TTS service initialized');
    }
  }

  resolveNarrationLanguage(text, explicit) {
    return resolveFonadaLanguage({
      explicit,
      text,
      fallback: this.fonadaLanguage || 'English'
    });
  }

  resolveSelectedVoice(options = {}) {
    return options.voiceRecord || null;
  }

  async generateTTSAudio(text, outputPath, options = {}) {
    this.logger.info('Generating TTS audio...');
    const language = this.resolveNarrationLanguage(text, options.language);
    const selectedVoice = this.resolveSelectedVoice(options);

    const attempts = [];
    if (this.canUseFonadaClone(options, selectedVoice)) {
      attempts.push({
        provider: 'fonada-klone',
        run: () => this.generateFonadaCloneTTS(text, outputPath, language, options)
      });
    }
    if (this.canUseFonadaV1()) {
      attempts.push({
        provider: 'fonada-v1',
        run: () => this.generateFonadaV1TTS(text, outputPath, language, options)
      });
    }
    if (this.openai) {
      attempts.push({ provider: 'openai', run: () => this.generateOpenAITTS(text, outputPath) });
    }
    if (this.gemini) {
      attempts.push({ provider: 'gemini', run: () => this.generateGeminiTTS(text, outputPath) });
    }
    if (this.elevenLabsApiKey && this.elevenLabsVoiceId) {
      attempts.push({ provider: 'elevenlabs', run: () => this.generateElevenLabsTTS(text, outputPath) });
    }

    let lastError = null;
    for (const attempt of attempts) {
      try {
        const resultPath = await attempt.run();
        this.lastNarration = { path: resultPath, provider: attempt.provider, language };
        this.logger.info(`TTS generation complete via ${attempt.provider} (${language.name})`);
        return resultPath;
      } catch (error) {
        lastError = error;
        this.logger.warn(`${attempt.provider} TTS failed, trying next provider: ${error.message}`);
      }
    }

    if (lastError) {
      this.logger.error('All live TTS providers failed; using silent simulation:', lastError);
    }
    const resultPath = await this.simulateTTSGeneration(text, outputPath);
    this.lastNarration = { path: resultPath, provider: 'simulated', language };
    return resultPath;
  }

  resolveCloneShareId(options = {}, selectedVoice = null) {
    if (options.shareId) return options.shareId;
    if (selectedVoice?.source === 'clone' && selectedVoice.voiceId && selectedVoice.voiceId !== 'clone') {
      return selectedVoice.voiceId;
    }
    return this.fonadaShareId;
  }

  canUseFonadaClone(options = {}, selectedVoice = null) {
    const shareId = this.resolveCloneShareId(options, selectedVoice);
    if (!this.fonadaApiKey || !shareId || isV1OnlyModel(this.fonadaModel)) return false;
    if (selectedVoice?.source === 'v1') return false;
    return !selectedVoice || isKloneCatalogVoice(selectedVoice);
  }

  canUseFonadaV1() {
    return Boolean(this.fonadaApiKey);
  }

  async requestFonada(requestFn) {
    const maxAttempts = 3;
    let response;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      response = await requestFn();
      if (response.status !== 429 || attempt === maxAttempts) {
        return response;
      }

      const retryAfter = Number(response.headers?.['retry-after'] || 6);
      const waitMs = Math.max(1, Number.isFinite(retryAfter) ? retryAfter : 6) * 1000;
      this.logger.warn(`Fonada rate limited (429), retrying in ${waitMs}ms`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    return response;
  }

  async generateFonadaV1TTS(text, outputPath, language, options = {}) {
    const resolved = language || this.resolveNarrationLanguage(text, options.language);
    if (!resolved.v1Supported) {
      this.logger.warn(`Fonada V1 does not support ${resolved.name}; using English pronunciation`);
    }

    const selectedVoice = this.resolveSelectedVoice(options);
    const requestedVoice = selectedVoice?.source === 'v1'
      ? selectedVoice.voiceId
      : (selectedVoice ? null : options.voice);
    const voice = requestedVoice || this.fonadaVoice || defaultVoiceForLanguage(resolved);
    const chunks = chunkTextForTTS(text, V1_MAX_CHARS);
    if (chunks.length === 0) {
      throw new Error('Fonada V1 received empty narration text');
    }

    this.logger.info(`Generating Fonada V1 TTS (${resolved.v1}, voice ${voice}, ${chunks.length} chunk${chunks.length === 1 ? '' : 's'})`);

    const chunkPaths = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunkPath = `${outputPath}.fonada-v1-${i}.mp3`;
        const response = await this.requestFonada(() => axios.post(
          FONADA_V1_ENDPOINT,
          { input: chunks[i], voice, language: resolved.v1 },
          {
            headers: {
              Authorization: `Bearer ${this.fonadaApiKey}`,
              'Content-Type': 'application/json'
            },
            responseType: 'arraybuffer',
            timeout: 180000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            validateStatus: () => true
          }
        ));

        if (response.status >= 400) {
          throw new Error(parseFonadaError(response.data, response.status));
        }

        await fs.mkdir(path.dirname(chunkPath), { recursive: true });
        await fs.writeFile(chunkPath, Buffer.from(response.data));
        chunkPaths.push(chunkPath);
      }

      await this.concatAudioChunks(chunkPaths, outputPath);
      return outputPath;
    } finally {
      await this.cleanupFiles(chunkPaths.filter(chunkPath => chunkPath !== outputPath));
    }
  }

  async generateFonadaCloneTTS(text, outputPath, language, options = {}) {
    const resolved = language || this.resolveNarrationLanguage(text, options.language);
    const selectedVoice = this.resolveSelectedVoice(options);
    const shareId = this.resolveCloneShareId(options, selectedVoice);
    if (!shareId) {
      throw new Error('FONADA_SHARE_ID is required for Klone V2 narration');
    }

    const chunks = chunkTextForTTS(text, CLONE_MAX_CHARS);
    if (chunks.length === 0) {
      throw new Error('Fonada Klone received empty narration text');
    }

    const catalogLabel = selectedVoice?.name ? `, voice ${selectedVoice.name}` : '';
    this.logger.info(`Generating Fonada Klone V2 TTS (${resolved.iso}${catalogLabel}, ${chunks.length} chunk${chunks.length === 1 ? '' : 's'})`);

    const chunkPaths = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunkPath = `${outputPath}.fonada-klone-${i}.wav`;
        const form = new FormData();
        form.append('share_id', shareId);
        form.append('text', chunks[i]);
        form.append('language', resolved.iso);
        form.append('output_audio_codec', 'wav');

        const response = await this.requestFonada(() => axios.post(FONADA_CLONE_ENDPOINT, form, {
          headers: {
            Authorization: `Bearer ${this.fonadaApiKey}`,
            ...form.getHeaders()
          },
          responseType: 'arraybuffer',
          timeout: 180000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          validateStatus: () => true
        }));

        if (response.status >= 400) {
          throw new Error(parseFonadaError(response.data, response.status));
        }

        await fs.mkdir(path.dirname(chunkPath), { recursive: true });
        await fs.writeFile(chunkPath, Buffer.from(response.data));
        chunkPaths.push(chunkPath);
      }

      await this.concatAudioChunks(chunkPaths, outputPath);
      return outputPath;
    } finally {
      await this.cleanupFiles(chunkPaths.filter(chunkPath => chunkPath !== outputPath));
    }
  }

  async concatAudioChunks(chunkPaths, outputPath) {
    if (chunkPaths.length === 1) {
      const source = chunkPaths[0];
      if (path.resolve(source) === path.resolve(outputPath)) {
        return outputPath;
      }
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      if (path.extname(source).toLowerCase() === path.extname(outputPath).toLowerCase()) {
        await fs.copyFile(source, outputPath);
        return outputPath;
      }
      await runFFmpeg(['-y', '-i', source, '-c:a', 'libmp3lame', '-ar', '24000', '-ac', '1', outputPath]);
      return outputPath;
    }

    const listPath = `${outputPath}.concat.txt`;
    const list = chunkPaths
      .map(chunkPath => `file '${String(chunkPath).replace(/'/g, "'\\''")}'`)
      .join('\n');

    await fs.writeFile(listPath, list);
    try {
      await runFFmpeg([
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c:a', 'libmp3lame', '-ar', '24000', '-ac', '1',
        outputPath
      ]);
      return outputPath;
    } finally {
      await fs.unlink(listPath).catch(() => {});
    }
  }

  async cleanupFiles(filePaths = []) {
    for (const filePath of filePaths) {
      await fs.unlink(filePath).catch(() => {});
    }
  }

  async generateElevenLabsTTS(text, outputPath) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`;
    
    const data = {
      text: text,
      model_id: "eleven_v3",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true
      }
    };

    const response = await axios({
      method: 'POST',
      url: url,
      data: data,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey
      },
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        this.logger.info('ElevenLabs TTS generation complete');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  }

  async generateOpenAITTS(text, outputPath) {
    const response = await this.openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: text,
      speed: 1.0
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    this.logger.info('OpenAI TTS generation complete');
    return outputPath;
  }

  async generateGeminiTTS(text, outputPath) {
    const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
    const voiceName = process.env.GEMINI_TTS_VOICE || 'Kore';

    const response = await this.gemini.models.generateContent({
      model,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    });

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      throw new Error('Gemini TTS returned no audio data');
    }

    // Gemini returns raw PCM (24kHz, mono, 16-bit); encode to the requested container via FFmpeg
    const pcmPath = outputPath + '.pcm';
    await fs.writeFile(pcmPath, Buffer.from(audioData, 'base64'));
    await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, outputPath]);
    await fs.unlink(pcmPath).catch(() => {});

    this.logger.info('Gemini TTS generation complete');
    return outputPath;
  }

  async generateVisualAssets(prompt, style = "ethereal", count = 1) {
    this.logger.info(`Generating ${count} visual assets with style: ${style}`);

    try {
      if (!this.openai && !this.gemini) {
        return await this.simulateVisualAssets(prompt, style, count);
      }

      const enhancedPrompt = this.enhanceVisualPrompt(prompt, style);
      const localPaths = [];

      for (let i = 0; i < count; i++) {
        const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_${i}.png`);
        await this.generateImage(enhancedPrompt, imagePath);
        localPaths.push(imagePath);
      }

      this.logger.info(`Generated ${localPaths.length} visual assets`);
      return localPaths;
    } catch (error) {
      this.logger.error('Visual asset generation failed:', error);
      return await this.simulateVisualAssets(prompt, style, count);
    }
  }

  async generateImage(prompt, imagePath) {
    await fs.mkdir(path.dirname(imagePath), { recursive: true });

    if (this.openai) {
      return await this.generateOpenAIImage(prompt, imagePath);
    }

    if (this.gemini) {
      return await this.generateGeminiImage(prompt, imagePath);
    }

    throw new Error('No image generation provider configured');
  }

  async generateOpenAIImage(prompt, imagePath) {
    const response = await this.openai.images.generate({
      model: "gpt-image-2",
      prompt: prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
    });

    if (response.data[0].b64_json) {
      const buffer = Buffer.from(response.data[0].b64_json, 'base64');
      await fs.writeFile(imagePath, buffer);
    } else {
      await this.downloadImage(response.data[0].url, imagePath);
    }

    return imagePath;
  }

  async generateGeminiImage(prompt, imagePath) {
    const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

    const response = await this.gemini.models.generateContent({
      model,
      contents: prompt
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(part => part.inlineData?.data);
    if (!imagePart) {
      throw new Error('Gemini image generation returned no image data');
    }

    await fs.writeFile(imagePath, Buffer.from(imagePart.inlineData.data, 'base64'));
    return imagePath;
  }

  enhanceVisualPrompt(prompt, style) {
    const styleEnhancements = {
      ethereal: "ethereal, dreamy, mystical, soft lighting, floating particles, cosmic background",
      modern: "modern, clean, minimalist, professional, sleek design, contemporary",
      animated: "animated style, cartoon, vibrant colors, expressive, dynamic",
      cinematic: "cinematic lighting, dramatic, movie poster style, high contrast",
      abstract: "abstract art, geometric shapes, gradient colors, artistic composition"
    };

    const enhancement = styleEnhancements[style] || styleEnhancements.ethereal;
    return `${prompt}, ${enhancement}, high quality, 16:9 aspect ratio, digital art`;
  }

  async downloadImage(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async generateVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Generating video from assets...');
    
    try {
      // Try Replicate for video generation first
      if (this.replicate && this.replicate.auth) {
        return await this.generateReplicateVideo(script, visualAssets, audioPath, outputPath);
      }
      
      // Fallback to simple slideshow with Playwright
      return await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath);
    } catch (error) {
      // The Logger's console line only shows the message string, so put the real
      // reason inline. Previously the stack alone went to the file transport and
      // the console printed "Video generation failed:" with no detail.
      const reason = error && error.message ? error.message : String(error);
      this.logger.error(`Video generation failed: ${reason}`, error);
      return await this.simulateVideoGeneration(script, visualAssets, audioPath, outputPath);
    }
  }

  async generateReplicateVideo(script, visualAssets, audioPath, outputPath) {
    const output = await this.replicate.run(
      "wan-video/wan-2.7-i2v",
      {
        input: {
          image: visualAssets[0],
          prompt: script.title || "smooth cinematic motion",
          duration: 5,
          resolution: "720p"
        }
      }
    );

    // Download the generated video
    if (output && output.length > 0) {
      await this.downloadVideo(output[0], outputPath);
      
      // Add audio track
      await this.addAudioToVideo(outputPath, audioPath, outputPath);
    }

    return outputPath;
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Creating slideshow video...');

    if (!(await checkFFmpeg())) {
      throw new Error(ffmpegInstallHint());
    }

    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const slidesDir = path.join(path.dirname(outputPath), 'slides');

    try {
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1920, height: 1080 });

      // Create HTML for slideshow (only real image files can be embedded)
      const imageAssets = await this.filterImageAssets(visualAssets);
      await page.setContent(this.createSlideshowHTML(script, imageAssets));

      // Freeze CSS transitions/animations so each still is captured fully rendered
      await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
      await page.waitForTimeout(1000); // Wait for assets to load

      // Capture ONE still per slide instead of screenshotting at 30fps —
      // FFmpeg turns the stills into a crossfaded video in seconds.
      const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
      await fs.mkdir(slidesDir, { recursive: true });

      const stills = [];
      for (let i = 0; i < slideCount; i++) {
        await page.evaluate((index) => {
          document.querySelectorAll('.slide').forEach((slide, s) => {
            slide.classList.toggle('active', s === index);
          });
        }, i);

        const stillPath = path.join(slidesDir, `slide_${String(i).padStart(3, '0')}.png`);
        await page.screenshot({ path: stillPath });
        stills.push(stillPath);
      }

      const videoPath = outputPath.replace('.mp4', '_visual.mp4');
      const duration = await this.resolveSlideshowDuration(script, audioPath);
      this.logger.info(`Creating slideshow with ${stills.length} slides over ${duration.toFixed(1)}s`);
      await this.renderSlidesToVideo(stills, duration, videoPath);

      // Add audio
      await this.addAudioToVideo(videoPath, audioPath, outputPath);

      return outputPath;
    } finally {
      await browser.close().catch(() => {});
      await this.cleanupDirectory(slidesDir);
    }
  }

  async renderSlidesToVideo(stills, totalDuration, videoPath) {
    if (stills.length === 0) {
      throw new Error('No slides to render');
    }

    const target = Math.max(2, Number(totalDuration) || 0);
    const base = target / stills.length;
    const clipsDir = path.join(path.dirname(videoPath), `slideclips_${Date.now()}`);
    await fs.mkdir(clipsDir, { recursive: true });

    try {
      const clips = [];
      let allocated = 0;
      for (let i = 0; i < stills.length; i++) {
        const clipDuration = i === stills.length - 1
          ? Math.max(2, target - allocated)
          : Math.max(2, base);
        allocated += clipDuration;
        const clipPath = path.join(clipsDir, `clip_${String(i).padStart(3, '0')}.mp4`);
        await runFFmpeg([
          '-y',
          '-loop', '1',
          '-i', stills[i],
          '-t', clipDuration.toFixed(3),
          '-vf', 'fps=24,format=yuv420p',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'stillimage',
          '-pix_fmt', 'yuv420p',
          clipPath
        ]);
        clips.push(clipPath);
      }

      if (clips.length === 1) {
        await fs.copyFile(clips[0], videoPath);
        return videoPath;
      }

      const listPath = path.join(clipsDir, 'concat.txt');
      const list = clips
        .map(clipPath => `file '${path.basename(clipPath).replace(/'/g, "'\\''")}'`)
        .join('\n');
      await fs.writeFile(listPath, list);
      await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', videoPath]);
      return videoPath;
    } finally {
      await this.cleanupDirectory(clipsDir);
    }
  }

  async filterImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const images = [];

    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) {
        continue;
      }

      try {
        await fs.access(asset);
        images.push(pathToFileURL(asset).href);
      } catch (error) {
        // Skip missing files
      }
    }

    return images;
  }

  createSlideshowHTML(script, visualAssets) {
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            width: 1920px;
            height: 1080px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'Arial', sans-serif;
            overflow: hidden;
        }
        
        .slide {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 2s ease-in-out;
        }
        
        .slide.active {
            opacity: 1;
        }
        
        .content {
            text-align: center;
            color: white;
            max-width: 80%;
        }
        
        h1 {
            font-size: 72px;
            margin-bottom: 30px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        h2 {
            font-size: 44px;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        p {
            font-size: 28px;
            line-height: 1.35;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
            margin: 0 0 16px 0;
        }
        
        .background-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: 0.3;
            z-index: -1;
        }
        
        .particles {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            z-index: -1;
        }
        
        .particle {
            position: absolute;
            background: rgba(255,255,255,0.8);
            border-radius: 50%;
            animation: float 6s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
        }
    </style>
</head>
<body>
    <div class="particles"></div>
    
    <!-- Title Slide -->
    <div class="slide active">
        ${visualAssets[0] ? `<img class="background-image" src="${visualAssets[0]}" />` : ''}
        <div class="content">
            <h1>${this.escapeSlideHtml(script.title)}</h1>
            <p>${this.escapeSlideHtml(script.hook?.text || 'Ethereal Dreamscript')}</p>
        </div>
    </div>
    
    ${this.generateContentSlides(script, visualAssets).join('')}
    
    <!-- Subscribe Slide -->
    <div class="slide">
        <div class="content">
            <h2>${this.escapeSlideHtml(script.callToAction?.subscribe ? 'Subscribe' : 'Subscribe for more')}</h2>
            <p>${this.escapeSlideHtml(script.callToAction?.subscribe || 'New videos on this channel')}</p>
            ${script.callToAction?.like ? `<p>${this.escapeSlideHtml(script.callToAction.like)}</p>` : ''}
        </div>
    </div>
    
    <script>
        // Create floating particles
        function createParticles() {
            const container = document.querySelector('.particles');
            for (let i = 0; i < 20; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.width = (Math.random() * 4 + 2) + 'px';
                particle.style.height = particle.style.width;
                particle.style.animationDelay = Math.random() * 6 + 's';
                container.appendChild(particle);
            }
        }
        
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        
        function advanceAnimation() {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }
        
        window.advanceAnimation = advanceAnimation;
        createParticles();
    </script>
</body>
</html>`;
  }

  generateContentSlides(script, visualAssets) {
    const slides = [];
    const pickImage = (index) => {
      if (!visualAssets.length) return '';
      return visualAssets[Math.min(Math.max(index, 0), visualAssets.length - 1)];
    };

    const introLines = [
      script.introduction?.greeting,
      script.introduction?.topicIntro,
      script.introduction?.valueProposition
    ].filter(Boolean);
    if (introLines.length) {
      slides.push(this.buildSlideHtml('Introduction', introLines.slice(0, 3), pickImage(0)));
    }

    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        const lines = this.sectionSpokenLines(section);
        const groups = this.chunkLines(lines, 2);
        groups.forEach((group, groupIndex) => {
          const title = groupIndex === 0 ? section.title : `${section.title} (continued)`;
          slides.push(this.buildSlideHtml(title, group, pickImage(index + 1)));
        });
      });
    }

    const recap = Array.isArray(script.conclusion?.recap) ? script.conclusion.recap.filter(Boolean) : [];
    if (recap.length || script.conclusion?.finalThought) {
      const closing = recap.concat(script.conclusion?.finalThought || []).filter(Boolean).slice(0, 4);
      slides.push(this.buildSlideHtml(script.conclusion?.title || 'Key takeaways', closing, pickImage(visualAssets.length - 1)));
    }

    return slides;
  }

  buildSlideHtml(title, lines, image) {
    return `
        <div class="slide">
            ${image ? `<img class="background-image" src="${image}" />` : ''}
            <div class="content">
                <h2>${this.escapeSlideHtml(title)}</h2>
                ${this.formatSectionLines(lines)}
            </div>
        </div>`;
  }

  sectionSpokenLines(section = {}) {
    if (Array.isArray(section.content) && section.content.length) {
      return section.content.map(line => String(line).trim()).filter(Boolean);
    }
    if (typeof section.content === 'string' && section.content.trim()) {
      return [section.content.trim()];
    }
    if (Array.isArray(section.items) && section.items.length) {
      return section.items.map(item => [item.number, item.title, item.description].filter(Boolean).join('. '));
    }
    if (Array.isArray(section.steps) && section.steps.length) {
      return section.steps.map(step => [step.title, step.description].filter(Boolean).join('. '));
    }
    if (Array.isArray(section.points) && section.points.length) {
      return section.points.map(point => String(point).trim()).filter(Boolean);
    }
    return [];
  }

  chunkLines(lines, size = 2) {
    const items = Array.isArray(lines) ? lines.filter(Boolean) : [];
    if (!items.length) return [['']];
    const groups = [];
    for (let i = 0; i < items.length; i += size) {
      groups.push(items.slice(i, i + size));
    }
    return groups;
  }

  formatSectionLines(lines = []) {
    const items = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
    if (!items.length) {
      return '<p></p>';
    }
    return items.map(line => {
      const text = String(line).trim();
      const clipped = text.length > 280 ? `${text.slice(0, 277)}…` : text;
      return `<p>${this.escapeSlideHtml(clipped)}</p>`;
    }).join('');
  }

  formatSectionContent(section) {
    const lines = this.sectionSpokenLines(section);
    if (lines.length) {
      return this.formatSectionLines(lines.slice(0, 3));
    }
    return '<p></p>';
  }

  escapeSlideHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  collectSpokenText(script = {}) {
    const parts = [];
    if (script.hook?.text) parts.push(script.hook.text);
    const intro = script.introduction || {};
    for (const key of ['greeting', 'topicIntro', 'valueProposition', 'credibility']) {
      if (intro[key]) parts.push(intro[key]);
    }
    for (const section of script.mainContent?.sections || []) {
      parts.push(...this.sectionSpokenLines(section));
    }
    if (Array.isArray(script.conclusion?.recap)) parts.push(...script.conclusion.recap);
    if (script.conclusion?.finalThought) parts.push(script.conclusion.finalThought);
    const cta = script.callToAction || {};
    for (const key of ['subscribe', 'like', 'comment', 'nextVideo']) {
      if (cta[key]) parts.push(cta[key]);
    }
    return parts.filter(Boolean).join(' ');
  }

  calculateScriptDuration(script) {
    const words = this.collectSpokenText(script).split(/\s+/).filter(Boolean).length;
    return Math.max(30, Math.ceil((words / 150) * 60));
  }

  async resolveSlideshowDuration(script, audioPath) {
    if (await this.isUsableAudioFile(audioPath)) {
      const audioSeconds = await getMediaDuration(audioPath);
      if (audioSeconds >= 5) {
        return audioSeconds + 0.35;
      }
    }
    return this.calculateScriptDuration(script);
  }

  async extendVideoToDuration(videoPath, targetSeconds) {
    const current = await getMediaDuration(videoPath);
    const extra = Number(targetSeconds) - current;
    if (!(extra > 0.05) || !Number.isFinite(extra)) {
      return videoPath;
    }

    const dir = path.dirname(videoPath);
    const stem = path.basename(videoPath, path.extname(videoPath));
    const framePath = path.join(dir, `${stem}_tail.png`);
    const tailPath = path.join(dir, `${stem}_tail.mp4`);
    const listPath = path.join(dir, `${stem}_tail.txt`);
    const extendedPath = path.join(dir, `${stem}_extended.mp4`);

    try {
      await runFFmpeg(['-y', '-sseof', '-0.1', '-i', videoPath, '-frames:v', '1', framePath]);
      await runFFmpeg([
        '-y',
        '-loop', '1',
        '-i', framePath,
        '-t', extra.toFixed(3),
        '-vf', 'fps=24,format=yuv420p',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'stillimage',
        '-pix_fmt', 'yuv420p',
        tailPath
      ]);
      await fs.writeFile(
        listPath,
        `file '${path.basename(videoPath).replace(/'/g, "'\\''")}'\nfile '${path.basename(tailPath).replace(/'/g, "'\\''")}'\n`
      );
      await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', extendedPath]);
      return extendedPath;
    } finally {
      await this.cleanupFiles([framePath, tailPath, listPath]);
    }
  }

  async addAudioToVideo(videoPath, audioPath, outputPath) {
    const hasRealAudio = await this.isUsableAudioFile(audioPath);

    if (!hasRealAudio) {
      this.logger.warn('No narration audio available — producing silent video. Configure Fonada Labs, Gemini TTS, or OpenAI for narration.');
      if (videoPath !== outputPath) {
        await fs.copyFile(videoPath, outputPath);
      }
      return outputPath;
    }

    // FFmpeg cannot write to its own input, so mux to a temp file when paths collide
    const muxPath = outputPath === videoPath
      ? outputPath.replace(/\.mp4$/i, '_muxed.mp4')
      : outputPath;

    const audioDuration = await getMediaDuration(audioPath);
    const videoDuration = await getMediaDuration(videoPath);
    const visualInput = await this.extendVideoToDuration(
      videoPath,
      audioDuration > 0 ? audioDuration + 0.2 : videoDuration
    );

    // Do not use -shortest. That flag stops at the first stream that ends,
    // so a slideshow that is even 1s short will cut the last words.
    await runFFmpeg(['-y', '-i', visualInput, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac', muxPath]);

    if (muxPath !== outputPath) {
      await fs.rename(muxPath, outputPath);
    }

    const muxedDuration = await getMediaDuration(outputPath);
    if (audioDuration > 0 && muxedDuration + 0.2 < audioDuration) {
      throw new Error(`Narration was trimmed during mux (${muxedDuration.toFixed(1)}s video, ${audioDuration.toFixed(1)}s audio)`);
    }

    this.logger.info(`Audio added to video successfully (${muxedDuration.toFixed(1)}s, narration ${audioDuration.toFixed(1)}s)`);
    return outputPath;
  }

  async isUsableAudioFile(audioPath) {
    if (typeof audioPath !== 'string' || audioPath.endsWith('.info')) {
      return false;
    }

    try {
      const stats = await fs.stat(audioPath);
      return stats.isFile() && stats.size > 0;
    } catch (error) {
      return false;
    }
  }

  async downloadVideo(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async cleanupDirectory(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        await fs.unlink(path.join(dirPath, file));
      }
      await fs.rmdir(dirPath);
    } catch (error) {
      this.logger.warn('Cleanup failed:', error.message);
    }
  }

  async generateThumbnail(script, style = "ethereal") {
    this.logger.info('Generating custom thumbnail...');

    try {
      if (!this.openai && !this.gemini) {
        return await this.simulateThumbnailGeneration(script, style);
      }

      const prompt = `YouTube thumbnail for "${script.title}", ${style} style, eye-catching, high contrast text, professional design, clickable, engaging`;
      const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${Date.now()}.png`);

      await this.generateImage(prompt, thumbnailPath);

      return {
        path: thumbnailPath,
        dimensions: { width: 1536, height: 1024 },
        fileSize: await this.getFileSize(thumbnailPath)
      };
    } catch (error) {
      this.logger.error('Thumbnail generation failed:', error);
      return await this.simulateThumbnailGeneration(script, style);
    }
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  // Simulation methods for when APIs are not available
  async simulateTTSGeneration(text, outputPath) {
    this.logger.info('Simulating TTS generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI TTS audio would be generated here',
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateVisualAssets(prompt, style, count) {
    this.logger.info(`Simulating ${count} visual assets...`);
    
    const paths = [];
    for (let i = 0; i < count; i++) {
      const assetPath = path.join(__dirname, '..', 'data', 'assets', `visual_sim_${Date.now()}_${i}.info`);
      
      await fs.writeFile(assetPath, JSON.stringify({
        message: 'AI visual asset would be generated here',
        prompt: prompt,
        style: style,
        timestamp: new Date().toISOString()
      }, null, 2));
      
      paths.push(assetPath);
    }
    
    return paths;
  }

  async simulateVideoGeneration(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Simulating video generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI video would be generated here',
      script: script.title,
      visualAssets: visualAssets.length,
      audioPath: audioPath,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateThumbnailGeneration(script, style) {
    this.logger.info('Simulating thumbnail generation...');
    
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_sim_${Date.now()}.info`);
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    
    await fs.writeFile(thumbnailPath, JSON.stringify({
      message: 'AI thumbnail would be generated here',
      title: script.title,
      style: style,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return {
      path: thumbnailPath,
      dimensions: { width: 1792, height: 1024 },
      fileSize: 1024,
      simulated: true
    };
  }
}

module.exports = { AIVideoGenerator };