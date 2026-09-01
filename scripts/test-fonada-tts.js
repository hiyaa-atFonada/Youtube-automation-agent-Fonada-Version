#!/usr/bin/env node
'use strict';

/**
 * Standalone Fonada TTS test — no YouTube / Google credentials required.
 *
 * Offline (always):
 *   node scripts/test-fonada-tts.js --offline
 *
 * Live audio (needs FONADA_API_KEY):
 *   node scripts/test-fonada-tts.js
 *   node scripts/test-fonada-tts.js --lang hindi
 *   node scripts/test-fonada-tts.js --long
 *
 * Output files land in data/audio/fonada-test/
 */

require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const chalk = require('chalk');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const {
  chunkTextForTTS,
  detectLanguageFromText,
  resolveFonadaLanguage
} = require('../utils/fonada-tts');

const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'audio', 'fonada-test');

const SAMPLES = [
  {
    id: 'english',
    language: 'English',
    text: 'Welcome back. This is a Fonada Labs voice test for the YouTube automation pipeline.'
  },
  {
    id: 'hindi',
    language: 'Hindi',
    text: 'नमस्ते दोस्तों, यह फोनडा लैब्स की आवाज़ का परीक्षण है। आज हम एक छोटी सी बात समझेंगे।'
  },
  {
    id: 'tamil',
    language: 'Tamil',
    text: 'வணக்கம் நண்பர்களே, இது ஒரு Fonada குரல் சோதனை. இன்று ஒரு சிறிய பாடம் பார்க்கலாம்.'
  },
  {
    id: 'telugu',
    language: 'Telugu',
    text: 'నమస్కారం మిత్రులారా, ఇది ఒక ఫోనడా వాయిస్ టెస్ట్. ఈరోజు ఒక చిన్న విషయం నేర్చుకుందాం.'
  }
];

const LONG_ENGLISH = [
  'This longer clip checks that YouTube-length narration is split into Fonada chunks and stitched back together.',
  'Each sentence should still sound natural after the merge, with no obvious cut in the middle of a word.',
  'If you can hear this whole paragraph as one continuous track, chunking and FFmpeg concat are working.',
  'You do not need Google or YouTube credentials for this test. Only a Fonada API key is required.'
].join(' ');

function parseArgs(argv) {
  const args = {
    offline: argv.includes('--offline'),
    long: argv.includes('--long'),
    lang: null
  };
  const langIndex = argv.findIndex(arg => arg === '--lang' || arg.startsWith('--lang='));
  if (langIndex >= 0) {
    args.lang = argv[langIndex].includes('=')
      ? argv[langIndex].split('=')[1]
      : argv[langIndex + 1];
  }
  return args;
}

function maskSecret(value) {
  const text = String(value || '');
  if (text.length < 8) return text ? '***' : '(missing)';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

async function loadFonadaCredentials() {
  let fromFile = {};
  try {
    const raw = await fs.readFile(path.join(__dirname, '..', 'config', 'credentials.json'), 'utf8');
    fromFile = JSON.parse(raw).fonada || {};
  } catch (error) {
    fromFile = {};
  }

  return {
    apiKey: process.env.FONADA_API_KEY || fromFile.apiKey,
    voice: process.env.FONADA_VOICE || fromFile.voice,
    language: process.env.FONADA_LANGUAGE || fromFile.language,
    shareId: process.env.FONADA_SHARE_ID || fromFile.shareId,
    model: process.env.FONADA_TTS_MODEL || fromFile.model || 'v1'
  };
}

function printHeader() {
  console.log(chalk.cyan.bold('\n🎙️  Fonada TTS test'));
  console.log(chalk.gray('No Google / YouTube credentials needed.\n'));
}

async function runOfflineChecks() {
  console.log(chalk.cyan('1. Language detection (offline)'));
  const cases = [
    ...SAMPLES,
    { id: 'alias', language: 'hi-IN', text: 'नमस्ते' }
  ];

  let failed = 0;
  for (const sample of cases) {
    const resolved = sample.id === 'alias'
      ? resolveFonadaLanguage({ explicit: sample.language, text: sample.text })
      : detectLanguageFromText(sample.text);
    const expected = sample.id === 'alias' ? 'hi' : resolveFonadaLanguage({ explicit: sample.language }).iso;
    const ok = resolved.iso === expected;
    if (!ok) failed += 1;
    console.log(ok
      ? chalk.green(`  ✓ ${sample.id.padEnd(10)} → ${resolved.name} (${resolved.iso})`)
      : chalk.red(`  ✗ ${sample.id.padEnd(10)} → ${resolved.name} (${resolved.iso}), expected ${expected}`));
  }

  const chunks = chunkTextForTTS(LONG_ENGLISH, 80);
  const chunkOk = chunks.length > 1 && chunks.every(chunk => chunk.length <= 80);
  if (!chunkOk) failed += 1;
  console.log(chunkOk
    ? chalk.green(`  ✓ chunking     → ${chunks.length} pieces (max 80 chars)`)
    : chalk.red('  ✗ chunking failed'));

  return failed === 0;
}

function selectedSamples(langFilter) {
  if (!langFilter) return SAMPLES;
  const key = String(langFilter).trim().toLowerCase();
  const matched = SAMPLES.filter(sample => (
    sample.id === key ||
    sample.language.toLowerCase() === key ||
    sample.language.toLowerCase().startsWith(key)
  ));
  if (matched.length === 0) {
    throw new Error(`Unknown --lang value "${langFilter}". Use english, hindi, tamil, or telugu.`);
  }
  return matched;
}

async function runLiveChecks(fonada, args) {
  console.log(chalk.cyan('\n2. Live Fonada narration'));
  console.log(chalk.gray(`   key     ${maskSecret(fonada.apiKey)}`));
  console.log(chalk.gray(`   voice   ${fonada.voice || '(language default)'}`));
  console.log(chalk.gray(`   model   ${fonada.model}`));
  console.log(chalk.gray(`   clone   ${fonada.shareId ? maskSecret(fonada.shareId) : '(not set — V1 system voice)'}`));
  console.log(chalk.gray(`   output  ${OUTPUT_DIR}\n`));

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const generator = new AIVideoGenerator({ fonada });
  const results = [];

  const jobs = selectedSamples(args.lang).map(sample => ({
    ...sample,
    file: path.join(OUTPUT_DIR, `${sample.id}.mp3`),
    passLanguage: sample.language
  }));

  jobs.push({
    id: 'autodetect-hindi',
    language: 'auto',
    text: SAMPLES.find(sample => sample.id === 'hindi').text,
    file: path.join(OUTPUT_DIR, 'autodetect-hindi.mp3'),
    passLanguage: null
  });

  if (args.long) {
    jobs.push({
      id: 'long-english',
      language: 'English',
      text: LONG_ENGLISH,
      file: path.join(OUTPUT_DIR, 'long-english.mp3'),
      passLanguage: 'English'
    });
  }

  for (const job of jobs) {
    process.stdout.write(chalk.white(`  → ${job.id}... `));
    try {
      const outputPath = await generator.generateTTSAudio(job.text, job.file, {
        language: job.passLanguage || undefined
      });
      const narration = generator.lastNarration || {};
      const stats = await fs.stat(outputPath);
      if (path.extname(outputPath).toLowerCase() === '.info' || stats.size < 100) {
        throw new Error('provider returned a simulation instead of audio — check FONADA_API_KEY');
      }

      const line = `${job.id}  ${narration.provider || 'unknown'}  ${narration.language?.name || job.language}  ${stats.size} bytes  ${outputPath}`;
      console.log(chalk.green('ok'));
      console.log(chalk.gray(`     ${line}`));
      results.push({ id: job.id, ok: true, path: outputPath, bytes: stats.size, provider: narration.provider });
    } catch (error) {
      console.log(chalk.red('failed'));
      console.log(chalk.red(`     ${error.message}`));
      results.push({ id: job.id, ok: false, error: error.message });
    }
  }

  return results;
}

function printLiveHelp() {
  console.log(chalk.yellow('\nLive audio was skipped — add a Fonada key, then rerun.\n'));
  console.log(chalk.white('1. Get a key:  https://fonadalabs.ai/console'));
  console.log(chalk.white('2. Put this in youtube-automation-agent/.env:\n'));
  console.log(chalk.cyan('   FONADA_API_KEY=your-key-here'));
  console.log(chalk.cyan('   FONADA_VOICE=Dhruv\n'));
  console.log(chalk.white('3. Run:  npm run test:fonada'));
  console.log(chalk.gray('   Optional: --lang hindi   or   --long\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  printHeader();

  const offlineOk = await runOfflineChecks();
  const fonada = await loadFonadaCredentials();

  if (args.offline) {
    console.log(offlineOk
      ? chalk.green('\nOffline checks passed. Language detection and chunking are working.')
      : chalk.red('\nOffline checks failed.'));
    process.exit(offlineOk ? 0 : 1);
  }

  if (!fonada.apiKey) {
    printLiveHelp();
    process.exit(offlineOk ? 0 : 1);
  }

  const results = await runLiveChecks(fonada, args);
  const passed = results.filter(result => result.ok).length;
  const failed = results.length - passed;

  console.log(chalk.cyan('\nSummary'));
  console.log(chalk.green(`  ✓ offline language checks: ${offlineOk ? 'passed' : 'failed'}`));
  console.log(passed ? chalk.green(`  ✓ live clips: ${passed}/${results.length}`) : chalk.red(`  ✗ live clips: ${passed}/${results.length}`));
  if (failed) {
    console.log(chalk.red(`  ✗ failed: ${results.filter(result => !result.ok).map(result => result.id).join(', ')}`));
  } else {
    console.log(chalk.green('\nPlay the MP3s in data/audio/fonada-test/ to hear each language.'));
  }

  process.exit(offlineOk && failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(chalk.red(`\nFonada test crashed: ${error.message}`));
  process.exit(1);
});
