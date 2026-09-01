#!/usr/bin/env node
'use strict';

/**
 * Stream 1–5 YouTube videos into Fonada streaming ASR (no video file saved).
 * No Google / YouTube Data API credentials required — only FONADA_API_KEY + yt-dlp.
 *
 *   node scripts/test-fonada-asr.js \
 *     "https://www.youtube.com/watch?v=XXXXXXXXXXX" \
 *     "https://youtu.be/YYYYYYYYYYY"
 *
 *   node scripts/test-fonada-asr.js --lang hi --max-minutes 6 <url> <url> ...
 *   node scripts/test-fonada-asr.js --full <url>   # whole video, costs more credits
 *
 * If you pass no URLs, the script asks for up to 5 links.
 */

require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const chalk = require('chalk');
const inquirer = require('inquirer');
const { Database } = require('../database/db');
const { SpeakingStyleService } = require('../utils/speaking-style-service');
const { resolveAsrLanguage } = require('../utils/fonada-asr');
const { CONTENT_LANGUAGE_CHOICES } = require('../utils/fonada-tts');
const { resolveYtDlp } = require('../utils/youtube-audio');

function parseArgs(argv) {
  const args = {
    full: argv.includes('--full'),
    saveAudio: argv.includes('--save-audio'),
    lang: null,
    maxMinutes: Number(process.env.SPEAKING_STYLE_MAX_MINUTES || 8),
    urls: []
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lang' || arg === '--language') {
      args.lang = argv[++i];
    } else if (arg.startsWith('--lang=')) {
      args.lang = arg.split('=').slice(1).join('=');
    } else if (arg === '--max-minutes') {
      args.maxMinutes = Number(argv[++i]);
    } else if (arg.startsWith('--max-minutes=')) {
      args.maxMinutes = Number(arg.split('=')[1]);
    } else if (arg === '--full') {
      args.full = true;
    } else if (arg === '--save-audio') {
      args.saveAudio = true;
    } else if (!arg.startsWith('-')) {
      args.urls.push(arg);
    }
  }

  return args;
}

async function collectUrls(existing) {
  if (existing.length > 0) return existing.slice(0, 5);

  console.log(chalk.white('Paste up to 5 YouTube video links. Leave a line empty to stop.\n'));
  const urls = [];
  for (let i = 1; i <= 5; i++) {
    const { url } = await inquirer.prompt([{
      type: 'input',
      name: 'url',
      message: `Video ${i} URL:`
    }]);
    if (!String(url || '').trim()) break;
    urls.push(url.trim());
  }
  return urls;
}

function printSource(source, index) {
  console.log(chalk.green(`\n  ${index + 1}. ${source.title || source.videoId}`));
  console.log(chalk.gray(`     ${source.url}`));
  console.log(chalk.gray(`     ${source.language} · ${Math.round(source.durationSeconds || 0)}s · ${source.creditsUsed || 0} credits`));
  console.log(chalk.white(`     ${source.excerpt}`));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(chalk.cyan.bold('\n🎤 Fonada streaming ASR speaking-style test'));
  console.log(chalk.gray('Pipes YouTube audio into Fonada WebSocket ASR. No video file is saved.\n'));

  if (!process.env.FONADA_API_KEY) {
    console.log(chalk.red('FONADA_API_KEY is missing. Add it to .env and rerun.'));
    process.exit(1);
  }

  await resolveYtDlp();
  const urls = await collectUrls(args.urls);
  if (urls.length === 0) {
    console.log(chalk.yellow('No YouTube links provided.'));
    console.log(chalk.white('Example:'));
    console.log(chalk.cyan('  npm run test:fonada-asr -- --lang hi "https://www.youtube.com/watch?v=XXXXXXXXXXX"'));
    process.exit(1);
  }

  let langChoice = args.lang;
  if (!langChoice) {
    const { languageName } = await inquirer.prompt([{
      type: 'list',
      name: 'languageName',
      message: 'Which language should Fonada ASR use?',
      choices: CONTENT_LANGUAGE_CHOICES.map(choice => ({
        name: choice.iso === 'en' ? 'English (not accepted by this Fonada ASR key — use Hindi for English speech)' : choice.name,
        value: choice.iso
      })),
      default: 'hi'
    }]);
    langChoice = languageName;
  }
  const language = resolveAsrLanguage(langChoice);
  console.log(chalk.gray(`Language: ${language} (from your choice, not .env)`));
  console.log(chalk.gray(args.full
    ? 'Audio: full video'
    : `Audio: first ${args.maxMinutes} minute(s) of each video (use --full for the whole video)`));
  console.log(chalk.gray(`Videos: ${urls.length}\n`));

  const db = new Database();
  await db.initialize();

  try {
    const service = new SpeakingStyleService(db, {});
    const { sources, profile } = await service.ingestYouTubeVideos(urls, {
      language,
      maxMinutes: args.maxMinutes,
      full: args.full,
      saveAudio: args.saveAudio
    });

    sources.forEach(printSource);

    const reportPath = path.join(__dirname, '..', 'data', 'audio', 'style-sources', `style-report-${Date.now()}.json`);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({ sources, profile }, null, 2));

    console.log(chalk.cyan('\nLearned speaking style'));
    console.log(chalk.white(`  Opening: ${profile.openingStyle || '(none)'}`));
    console.log(chalk.white(`  Rhythm:  ${profile.sentenceRhythm || '(none)'}`));
    console.log(chalk.white(`  Vocab:   ${profile.vocabulary || '(none)'}`));
    console.log(chalk.white(`  CTA:     ${profile.ctaStyle || '(none)'}`));
    console.log(chalk.white(`  Energy:  ${profile.energy || '(none)'}`));
    if (profile.catchphrases?.length) {
      console.log(chalk.white(`  Phrases: ${profile.catchphrases.join(' | ')}`));
    }
    console.log(chalk.gray(`\nSaved profile for script writing. Report: ${reportPath}`));
    console.log(chalk.green('Future scripts will use this style automatically.\n'));
  } finally {
    await db.close();
  }
}

main().catch(error => {
  console.error(chalk.red(`\nFonada ASR test failed: ${error.message}`));
  process.exit(1);
});
