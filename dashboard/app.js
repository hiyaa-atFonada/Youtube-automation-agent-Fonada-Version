const ui = {
  state: null,
  currentView: 'overview',
  refreshing: false,
  toastTimer: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function apiKey() {
  return localStorage.getItem('yaa_api_key') || '';
}

function requestApiKey() {
  const key = prompt('Enter the API_KEY value from your .env. It stays in this browser only.', apiKey());
  if (key !== null) localStorage.setItem('yaa_api_key', key.trim());
  return key;
}

async function api(url, options = {}, retry = true) {
  const key = apiKey();
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'x-api-key': key } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 401 && retry && requestApiKey() !== null) return api(url, options, false);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || response.statusText || 'Request failed');
    error.data = data;
    throw error;
  }
  return data;
}

function showToast(message, type = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => toast.classList.add('hidden'), 4200);
}

function empty(message) {
  return `<div class="empty">${escapeHTML(message)}</div>`;
}

function parseTimestamp(value) {
  if (!value && value !== 0) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  // SQLite CURRENT_TIMESTAMP / datetime('now') is UTC with a space, no zone.
  // Browsers parse that as local time, which makes IST look ~5 hours behind.
  const sqliteUtc = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  const date = new Date(sqliteUtc ? `${sqliteUtc[1]}T${sqliteUtc[2]}Z` : raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value, includeTime = true) {
  if (!value) return 'Not scheduled';
  const date = parseTimestamp(value);
  if (!date) return 'Not scheduled';
  const requested = ui.state?.profile?.timezone || 'Asia/Kolkata';
  let timeZone = 'Asia/Kolkata';
  try {
    Intl.DateTimeFormat('en-IN', { timeZone: requested }).format(date);
    timeZone = requested;
  } catch (_error) {
    timeZone = 'Asia/Kolkata';
  }
  return new Intl.DateTimeFormat('en-IN', {
    month: 'short', day: 'numeric',
    timeZone,
    ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {})
  }).format(date);
}

function timeAgo(value) {
  if (!value) return '';
  const date = parseTimestamp(value);
  if (!date) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function label(value) {
  return String(value || 'unknown').replaceAll('_', ' ');
}

function statusChip(value) {
  const safe = String(value || 'unknown').toLowerCase();
  return `<span class="status ${escapeHTML(safe)}">${escapeHTML(label(safe))}</span>`;
}

async function refreshDashboard(silent = false) {
  if (ui.refreshing) return;
  ui.refreshing = true;
  if (!silent) $('#loading').classList.add('active');
  try {
    ui.state = await api('/api/dashboard');
    renderDashboard();
  } catch (error) {
    $('#system-label').textContent = 'Dashboard unavailable';
    $('#system-dot').classList.remove('online');
    if (!silent) showToast(error.message, 'error');
  } finally {
    ui.refreshing = false;
    $('#loading').classList.remove('active');
  }
}

function renderDashboard() {
  const state = ui.state;
  const reviews = state.pipeline.filter(item => ['needs_review', 'needs_attention'].includes(item.review_status));
  const scheduled = state.schedule.filter(item => item.status === 'scheduled');
  const activeJobs = state.jobs.filter(job => ['queued', 'running'].includes(job.status));

  $('#brand-name').textContent = state.profile?.channel_name || 'Automation Studio';
  const banner = $('#setup-banner');
  if (state.system.setupRequired) {
    banner.classList.remove('hidden');
    banner.innerHTML = '<div><strong>Finish setup to activate your agents</strong><p>The operator console is ready, but generation stays disabled until an AI provider is configured.</p></div><code>npm run walkthrough</code>';
  } else if (!state.system.youtubeReady) {
    banner.classList.remove('hidden');
    banner.innerHTML = '<div><strong>YouTube is optional until upload</strong><p>Generate, review, and export videos locally. Connect YouTube in Channel setup when you want to publish.</p></div><button class="text-button" data-go="settings">Open Channel setup →</button>';
  } else {
    banner.classList.add('hidden');
  }
  $('#system-label').textContent = state.system.setupRequired
    ? 'Setup required'
    : state.system.automationPaused ? 'Automation paused' : `${state.system.agents.length} agents online`;
  $('#system-dot').classList.toggle('online', state.system.initialized && !state.system.automationPaused && !state.system.setupRequired);
  $('#automation-toggle').textContent = state.system.automationPaused ? 'Resume automation' : 'Pause automation';
  $('#automation-toggle').disabled = state.system.setupRequired;
  $('#generate-button').disabled = state.system.setupRequired;
  $('#review-badge').textContent = reviews.length;
  $('#review-badge').classList.toggle('hidden', reviews.length === 0);

  $('#stat-review').textContent = reviews.length;
  $('#stat-scheduled').textContent = scheduled.length;
  $('#stat-published').textContent = state.stats.published || 0;
  $('#stat-score').textContent = state.analytics.averagePerformanceScore ? `${state.analytics.averagePerformanceScore}/100` : '—';

  fillSpokenLanguageSelects();
  renderYouTubeSettings(state.youtube || {});
  renderSpeakingStyle(state.speakingStyle || {});
  renderReviews(reviews);
  renderJobs(activeJobs.length ? activeJobs : state.jobs.slice(0, 5));
  renderSchedule(state.schedule.slice(0, 5), '#next-schedule');
  renderNotifications(state.notifications, state.events);
  renderPipeline(state.pipeline);
  renderCalendar(state.schedule);
  renderIdeas(state.ideas);
  renderAnalytics(state.analytics, state.learning);
  renderActivation(state.activation);
  renderReadiness(state.readiness);
  renderOperator(state.channelStrategy, state.operatorRuns || [], { ...state.system, readiness: state.readiness });
  populateSettings(state.profile, state.settings);
}

function renderReadiness(readiness = {}) {
  const status = readiness.status || 'unverified';
  const statusNode = $('#readiness-status');
  statusNode.className = `status ${escapeHTML(status)}`;
  statusNode.textContent = readiness.stale && status !== 'unverified' ? `${label(status)} · stale` : label(status);

  const titles = {
    passed: 'The production path is verified.',
    warning: 'Core checks passed with warnings.',
    failed: 'Automation is blocked until this is fixed.',
    unverified: 'Prove the pipeline, without uploading.'
  };
  $('#readiness-title').textContent = titles[status] || titles.unverified;
  const counts = readiness.summary || {};
  $('#readiness-summary').textContent = status === 'unverified'
    ? 'The check makes small live text and narration requests, verifies channel access, builds a local audio/video MP4, and validates queued metadata. It never creates or uploads a YouTube video.'
    : `${counts.passed || 0} passed, ${counts.warnings || 0} warning${counts.warnings === 1 ? '' : 's'}, and ${counts.failed || 0} failed.`;
  $('#readiness-meta').textContent = readiness.completed_at
    ? `Last run ${formatDate(readiness.completed_at)}${readiness.stale ? ' · older than 24 hours' : ''}`
    : 'No readiness run recorded.';

  const checks = Array.isArray(readiness.checks) ? readiness.checks : [];
  $('#readiness-checks').innerHTML = checks.length ? checks.map(check => `
    <article class="readiness-check ${escapeHTML(check.status)}">
      <div class="readiness-check-heading"><span class="readiness-icon" aria-hidden="true">${check.status === 'passed' ? '✓' : check.status === 'failed' ? '×' : '!'}</span><div><strong>${escapeHTML(check.label)}</strong><div class="meta-line">${escapeHTML(label(check.status))}${check.blocking ? ' · blocking' : ' · optional'} · ${(check.durationMs || 0) / 1000}s</div></div></div>
      <p>${escapeHTML(check.message)}</p>
      ${check.remediation ? `<small><strong>Next:</strong> ${escapeHTML(check.remediation)}</small>` : ''}
    </article>`).join('') : empty('Run the verified check to inspect every production dependency.');
}

function renderReviews(reviews) {
  const container = $('#review-list');
  if (!reviews.length) {
    container.innerHTML = empty('Nothing is waiting. New content will appear here after quality review.');
    return;
  }
  container.innerHTML = reviews.slice(0, 5).map(item => `
    <article class="review-card">
      ${item.hasThumbnail ? `<img class="review-thumb" src="/api/content/${encodeURIComponent(item.id)}/asset/thumbnail" alt="">` : '<div class="review-thumb"></div>'}
      <div class="review-meta"><strong>${escapeHTML(item.title)}</strong><div class="meta-line">${statusChip(item.review_status)} · Quality ${qualityScore(item.qualityChecks)}%</div></div>
      <button class="button secondary small" data-open-content="${escapeHTML(item.id)}">Review</button>
    </article>`).join('');
}

function renderJobs(jobs) {
  const container = $('#job-list');
  if (!jobs.length) {
    container.innerHTML = empty('No generation runs yet.');
    return;
  }
  container.innerHTML = jobs.slice(0, 6).map(job => `
    <article class="job-card">
      <div class="job-meta">
        <strong>${escapeHTML(job.title || job.topic || 'Agent-selected topic')}</strong>
        <div class="meta-line">${statusChip(job.status)} · ${escapeHTML(label(job.stage))} · ${timeAgo(job.updated_at)}</div>
        <div class="progress"><i style="width:${Math.max(0, Math.min(100, job.progress || 0))}%"></i></div>
      </div>
      ${['queued', 'running'].includes(job.status) ? `<button class="text-button" data-cancel-job="${escapeHTML(job.id)}">Cancel</button>` : ''}
    </article>`).join('');
}

function renderSchedule(schedule, selector) {
  const container = $(selector);
  if (!schedule.length) {
    container.innerHTML = empty('No approved videos are scheduled.');
    return;
  }
  container.innerHTML = schedule.map(item => `
    <div class="timeline-item">
      <div class="date-chip"><small>${escapeHTML(new Date(item.publish_time).toLocaleDateString(undefined, { month: 'short' }))}</small><strong>${escapeHTML(new Date(item.publish_time).getDate())}</strong></div>
      <div class="timeline-meta"><strong>${escapeHTML(item.title)}</strong><div class="meta-line">${formatDate(item.publish_time)} · ${statusChip(item.status)}</div></div>
      <button class="text-button" data-open-content="${escapeHTML(item.production_id)}">View</button>
    </div>`).join('');
}

function renderNotifications(notifications, events) {
  const items = notifications.length
    ? notifications
    : events.map(event => ({ level: event.status === 'error' ? 'error' : 'info', title: label(event.event_type), message: event.data?.error || label(event.status), created_at: event.created_at }));
  const container = $('#notification-list');
  if (!items.length) {
    container.innerHTML = empty('No activity has been recorded yet.');
    return;
  }
  container.innerHTML = items.slice(0, 7).map(item => `
    <div class="activity ${escapeHTML(item.level || 'info')}"><i></i><p><strong>${escapeHTML(item.title)}</strong><br><span class="meta-line">${escapeHTML(item.message)}</span></p><small>${timeAgo(item.created_at)}</small></div>`).join('');
}

function currentPipelineFilter() {
  return $('#pipeline-filter').value || 'all';
}

function renderPipeline(items) {
  const filter = currentPipelineFilter();
  const filtered = filter === 'all' ? items : items.filter(item =>
    item.review_status === filter || item.schedule_status === filter || item.status === filter
  );
  const container = $('#pipeline-list');
  if (!filtered.length) {
    container.innerHTML = empty('No content matches this view.');
    return;
  }
  container.innerHTML = filtered.map(item => {
    const state = item.schedule_status || item.review_status || item.status;
    const next = nextAction(item);
    return `<article class="pipeline-item" data-open-content="${escapeHTML(item.id)}">
      <div class="pipeline-title"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.topic || 'No topic recorded')} · ${formatDate(item.created_at)}</span></div>
      <div class="pipeline-col"><span>State</span><strong>${statusChip(state)}</strong></div>
      <div class="pipeline-col"><span>Quality</span><strong>${qualityScore(item.qualityChecks)} / 100</strong></div>
      <button class="button secondary small">${escapeHTML(next)} →</button>
    </article>`;
  }).join('');
}

function qualityScore(checks) {
  if (!Array.isArray(checks) || !checks.length) return 0;
  return Math.round((checks.filter(check => check.passed).length / checks.length) * 100);
}

function nextAction(item) {
  if (item.schedule_status === 'published') return 'View';
  if (item.review_status === 'needs_attention') return 'Fix issues';
  if (item.review_status === 'needs_review') return 'Review';
  if (item.schedule_status === 'scheduled') return 'Scheduled';
  return 'Inspect';
}

function renderCalendar(schedule) {
  renderSchedule(schedule, '#calendar-list');
}

function renderIdeas(ideas) {
  const container = $('#idea-list');
  if (!ideas.length) {
    container.innerHTML = empty('Add promising topics here before spending generation credits.');
    return;
  }
  container.innerHTML = ideas.map(idea => `
    <article class="idea-card">
      <div class="idea-meta"><strong>${escapeHTML(idea.topic)}</strong><div class="meta-line">${escapeHTML(idea.angle || idea.rationale || 'No angle added')} · ${statusChip(idea.status)}</div></div>
      ${idea.status === 'backlog' ? `<button class="button secondary small" data-generate-idea="${escapeHTML(idea.id)}">Generate</button>` : ''}
    </article>`).join('');
}

function renderAnalytics(analytics, learning = {}) {
  $('#analytics-total').textContent = analytics.totalVideos || 0;
  $('#analytics-score').textContent = analytics.averagePerformanceScore ? `${analytics.averagePerformanceScore}/100` : '—';
  const insights = Array.isArray(analytics.insights) ? analytics.insights : [];
  const approved = (learning.recommendations || []).find(item => item.status === 'approved');
  const pending = (learning.recommendations || []).find(item => item.status === 'pending');
  $('#analytics-action').textContent = approved?.title || pending?.title || insights[0] || (analytics.totalVideos
    ? 'Keep collecting results; recommendations get stronger with more published videos.'
    : 'Publish and analyze the first video to unlock performance recommendations.');
  const performers = Array.isArray(analytics.topPerformers) ? analytics.topPerformers : [];
  $('#top-performers').innerHTML = performers.length ? performers.map(item => `
    <article class="performer-card"><strong>${escapeHTML(item.videoDetails?.title || item.title || 'Untitled video')}</strong><div class="meta-line">Performance ${escapeHTML(item.performance?.score ?? item.performance_score ?? '—')} / 100</div></article>`).join('') : empty('No analyzed videos yet.');
  renderLearning(learning);
}

function renderLearning(learning = {}) {
  const baseline = learning.baseline || {};
  $('#learning-snapshot-count').textContent = `${learning.snapshotCount || 0} snapshots`;
  $('#learning-approved-count').textContent = `${learning.approvedCount || 0} approved`;
  const metrics = [
    ['CTR', baseline.ctr, '%'],
    ['Retention', baseline.retention, '%'],
    ['Engagement', baseline.engagementRate, '%'],
    ['Performance', baseline.performanceScore, '/100']
  ];
  $('#learning-baseline').innerHTML = learning.measuredVideos ? metrics.map(([name, value, suffix]) => `
    <div><span>${escapeHTML(name)}</span><strong>${Number(value || 0).toFixed(1)}${escapeHTML(suffix)}</strong></div>`).join('') : empty('Two real measurements unlock evidence-backed recommendations.');

  const recommendations = Array.isArray(learning.recommendations) ? learning.recommendations : [];
  $('#learning-recommendations').innerHTML = recommendations.length ? recommendations.map(item => `
    <article class="learning-card">
      <div class="learning-card-heading"><strong>${escapeHTML(item.title)}</strong>${statusChip(item.status)}</div>
      <p>${escapeHTML(item.rationale)}</p>
      <div class="learning-meta"><span>${escapeHTML(label(item.category))} · ${escapeHTML(label(item.confidence))} confidence</span>
        <span class="learning-actions">
          ${item.status !== 'approved' ? `<button class="text-button approve" data-learning-action="approve" data-learning-id="${escapeHTML(item.id)}">Approve</button>` : ''}
          ${item.status !== 'rejected' ? `<button class="text-button" data-learning-action="reject" data-learning-id="${escapeHTML(item.id)}">Reject</button>` : ''}
        </span>
      </div>
    </article>`).join('') : empty('No recommendation yet. Lumen needs at least two real, sufficiently exposed measurements.');
}

function renderActivation(activation = {}) {
  const container = $('#activation-list');
  if (!container) return;
  const milestones = activation.milestones || {};
  const rows = [
    ['Setup ready', milestones.setupReady],
    ['First real MP4', milestones.firstRealVideo],
    ['First approval', milestones.firstApproval],
    ['First YouTube publish', milestones.firstPublish],
    ['Second real MP4', milestones.secondRealVideo]
  ];
  container.innerHTML = rows.map(([name, milestone = {}]) => `
    <div class="timeline-item">
      <div class="timeline-dot ${milestone.achieved ? 'done' : ''}"></div>
      <div><strong>${escapeHTML(name)}</strong><div class="meta-line">${milestone.achieved ? escapeHTML(formatDate(milestone.at)) : 'Not reached yet'}</div></div>
    </div>`).join('');
  if (milestones.firstRealVideo?.achieved) {
    container.insertAdjacentHTML('beforeend', `
      <div class="activation-share">
        <span>Made something real with Lumen?</span>
        <a class="button secondary small" href="https://github.com/darkzOGx/youtube-automation-agent/discussions/new?category=show-and-tell" target="_blank" rel="noreferrer">Share what you built</a>
      </div>`);
  }
}

function renderOperator(strategy, runs, system) {
  const form = $('#strategy-form');
  const mapping = !isFormDirty(form) && strategy ? {
    objective: strategy.objective,
    audience: strategy.audience,
    valueProposition: strategy.value_proposition,
    contentPillars: (strategy.contentPillars || []).join(', '),
    cadencePerWeek: strategy.cadence_per_week,
    videosPerRun: strategy.videos_per_run,
    defaultFormat: strategy.default_format,
    defaultLength: strategy.default_length,
    defaultLanguage: strategy.default_language || 'hi',
    successMetric: strategy.success_metric,
    constraints: strategy.constraints
  } : {};
  for (const [name, value] of Object.entries(mapping)) {
    if (form.elements[name] && document.activeElement !== form.elements[name]) form.elements[name].value = value ?? '';
  }

  const strategyStatus = strategy?.status || 'not_configured';
  $('#operator-strategy-status').className = `status ${escapeHTML(strategyStatus)}`;
  $('#operator-strategy-status').textContent = label(strategyStatus);
  const run = runs[0];
  const active = run && ['queued', 'running', 'cancelling'].includes(run.status);
  $('#activate-operator-button').disabled = Boolean(system.setupRequired || active || system.readiness?.status === 'failed');
  $('#activate-operator-button').title = system.readiness?.status === 'failed' ? 'Resolve the production readiness failures first' : '';
  $('#activate-operator-button').textContent = strategy?.status === 'active' ? 'Run strategy now' : 'Activate & run now';
  $('#pause-operator-button').classList.toggle('hidden', strategy?.status !== 'active');
  $('#cancel-operator-run').classList.toggle('hidden', !active);
  if (active) $('#cancel-operator-run').dataset.runId = run.id;

  if (!run) {
    $('#operator-run-title').textContent = 'Waiting for a strategy';
    $('#operator-run-summary').innerHTML = empty('Save a channel mandate, then activate it to research and produce the first plan.');
    $('#operator-plan').innerHTML = empty('No editorial plan yet.');
    return;
  }

  $('#operator-run-title').textContent = `${label(run.stage)} · ${run.progress || 0}%`;
  const sources = Array.isArray(run.research?.sources) ? run.research.sources.join(', ') : 'Research pending';
  $('#operator-run-summary').innerHTML = `<div class="run-summary">
    <div class="progress"><i style="width:${Math.max(0, Math.min(100, run.progress || 0))}%"></i></div>
    <div class="run-summary-row"><span>Status</span><strong>${statusChip(run.status)}</strong></div>
    <div class="run-summary-row"><span>Research</span><strong>${escapeHTML(sources)}</strong></div>
    <div class="run-summary-row"><span>Produced</span><strong>${escapeHTML(run.summary?.generated || 0)} / ${escapeHTML(run.summary?.planned || run.plan?.length || 0)}</strong></div>
    <div class="run-summary-row"><span>Needs review</span><strong>${escapeHTML(run.summary?.needsReview || 0)}</strong></div>
    ${run.error ? `<p class="callout">${escapeHTML(run.error)}</p>` : ''}
  </div>`;
  const plan = Array.isArray(run.plan) ? run.plan : [];
  $('#operator-plan').innerHTML = plan.length ? plan.map((item, index) => {
    const job = (run.generatedJobs || []).find(candidate => candidate.topic === item.topic);
    return `<article class="plan-card">
      <div class="meta-line">${index + 1} · ${escapeHTML(item.format)} · ${escapeHTML(item.length)} ${job ? `· ${statusChip(job.reviewStatus || job.status)}` : ''}</div>
      <strong>${escapeHTML(item.topic)}</strong>
      <p>${escapeHTML(item.angle || item.rationale)}</p>
    </article>`;
  }).join('') : empty('Research and planning will appear here when the run begins.');
}

function isFormDirty(form) {
  return Boolean(form?.dataset.dirty);
}

function markFormDirty(event) {
  event.currentTarget.dataset.dirty = '1';
}

function clearFormDirty(form) {
  if (form) delete form.dataset.dirty;
}

function fillSpokenLanguageSelects() {
  const languages = ui.state?.spokenLanguages;
  if (!Array.isArray(languages) || languages.length === 0) return;
  $$('select[name="language"], select[name="defaultLanguage"]').forEach(select => {
    if (isFormDirty(select.form) || document.activeElement === select) return;
    const current = select.value;
    select.innerHTML = languages.map(language =>
      `<option value="${escapeHTML(language.iso)}">${escapeHTML(language.name)}</option>`
    ).join('');
    if (languages.some(language => language.iso === current)) select.value = current;
  });
}

function renderYouTubeSettings(youtube = {}) {
  const form = $('#youtube-form');
  const status = $('#youtube-status');
  const line = $('#youtube-channel-line');
  const disconnect = $('#youtube-disconnect-button');
  const redirect = $('#youtube-redirect-uri');
  if (!form || !status) return;

  status.textContent = youtube.connected ? 'Connected' : youtube.configured ? 'Client saved' : 'Not connected';
  status.className = `status ${youtube.connected ? 'published' : youtube.configured ? 'queued' : 'unverified'}`;
  disconnect.classList.toggle('hidden', !youtube.connected);
  if (redirect) {
    redirect.textContent = youtube.redirectUri || 'http://127.0.0.1:3456/api/youtube/callback';
  }

  if (youtube.channel?.title) {
    line.textContent = `Publishing as ${youtube.channel.title}${youtube.channel.subscribers ? ` · ${youtube.channel.subscribers} subscribers` : ''}`;
  } else if (youtube.connected) {
    line.textContent = 'Google account is connected. Approving a video will upload to that channel.';
  } else if (youtube.configured) {
    line.textContent = 'Client is saved. Click Connect Google account to finish sign-in.';
  } else {
    line.textContent = 'Save a Google OAuth client, then sign in. Generation still works without this.';
  }

  if (!isFormDirty(form) && document.activeElement !== form.elements.clientId) {
    form.elements.clientId.placeholder = youtube.clientIdMasked
      ? `Saved: ${youtube.clientIdMasked}`
      : '123456789-abc.apps.googleusercontent.com';
  }
}

function renderSpeakingStyle(style = {}) {
  const form = $('#speaking-style-form');
  const status = $('#speaking-style-status');
  const summary = $('#speaking-style-summary');
  const profileBox = $('#speaking-style-profile');
  const sourcesBox = $('#speaking-style-sources');
  const learn = $('#speaking-style-learn-button');
  const enabled = $('#speaking-style-enabled');
  if (!form || !status) return;

  const job = style.job || {};
  const profile = style.profile;
  const running = job.status === 'running';
  status.textContent = running
    ? 'Learning'
    : job.status === 'failed'
      ? 'Failed'
      : profile
        ? 'Learned'
        : 'Not learned';
  status.className = `status ${running ? 'queued' : job.status === 'failed' ? 'failed' : profile ? 'published' : 'unverified'}`;
  if (learn) {
    learn.disabled = running;
    learn.textContent = running ? 'Learning from videos…' : 'Learn speaking style';
  }
  if (enabled && document.activeElement !== enabled) {
    enabled.checked = style.enabled !== false;
  }

  if (job.status === 'failed' && job.error) {
    summary.textContent = job.error;
  } else if (running) {
    summary.textContent = job.message || 'Fonada is transcribing the videos. This can take a few minutes.';
  } else if (profile) {
    summary.textContent = `Style from ${profile.sourceVideoCount || style.sources?.length || 0} video(s). Next scripts will follow this delivery.`;
  } else {
    summary.textContent = 'Paste your videos or inspiration. Fonada transcribes them and the next scripts copy that delivery.';
  }

  if (profileBox) {
    profileBox.innerHTML = profile
      ? [
        profile.openingStyle && `<p><strong>Opening</strong> · ${escapeHTML(profile.openingStyle)}</p>`,
        profile.sentenceRhythm && `<p><strong>Rhythm</strong> · ${escapeHTML(profile.sentenceRhythm)}</p>`,
        profile.energy && `<p><strong>Energy</strong> · ${escapeHTML(profile.energy)}</p>`,
        profile.vocabulary && `<p><strong>Vocabulary</strong> · ${escapeHTML(profile.vocabulary)}</p>`,
        profile.ctaStyle && `<p><strong>CTA</strong> · ${escapeHTML(profile.ctaStyle)}</p>`
      ].filter(Boolean).join('')
      : '';
  }

  if (sourcesBox) {
    const sources = style.sources || [];
    sourcesBox.innerHTML = sources.map(source =>
      `<article class="idea-card"><strong>${escapeHTML(source.title || source.videoId || 'Video')}</strong><div class="meta-line">${escapeHTML(source.language || '')}${source.durationSeconds ? ` · ${Math.round(source.durationSeconds)}s` : ''}</div><p>${escapeHTML(source.excerpt || '')}</p></article>`
    ).join('');
  }

  if (!isFormDirty(form) && job.urls?.length) {
    job.urls.slice(0, 5).forEach((url, index) => {
      const field = form.elements[`url${index + 1}`];
      if (field && document.activeElement !== field && !field.value) field.value = url;
    });
  }
}

function populateSettings(profile = {}, settings = {}) {
  const form = $('#profile-form');
  if (isFormDirty(form)) return;
  const mapping = {
    channelName: profile.channel_name,
    goal: profile.goal,
    targetAudience: profile.target_audience,
    brandVoice: profile.brand_voice,
    defaultStyle: profile.default_style,
    defaultLanguage: profile.default_language || 'hi',
    defaultVoice: profile.default_voice || '',
    callToAction: profile.call_to_action,
    visualStyle: profile.visual_style,
    timezone: /^(indian|india|ist|asia\/kolkata|asia\/calcutta)?$/i.test(String(profile.timezone || '').trim())
      ? 'Asia/Kolkata'
      : (profile.timezone || 'Asia/Kolkata'),
    bannedTopics: (profile.bannedTopics || []).join(', ')
  };
  for (const [name, value] of Object.entries(mapping)) {
    if (form.elements[name] && document.activeElement !== form.elements[name]) form.elements[name].value = value || '';
  }
  $('#approval-required').checked = settings.approval_required !== 'false';
  $('#notifications-enabled').checked = settings.notification_enabled !== 'false';
}

function switchView(view) {
  ui.currentView = view;
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  $$('.view').forEach(item => item.classList.toggle('active', item.id === `${view}-view`));
  const titles = {
    overview: ['OPERATOR OVERVIEW', 'Know what happens next.'],
    operator: ['AUTONOMOUS OPERATOR', 'Give Lumen the strategy.'],
    pipeline: ['CONTENT OPERATIONS', 'From idea to published.'],
    calendar: ['EDITORIAL PLANNING', 'Plan before you generate.'],
    analytics: ['PERFORMANCE', 'Turn results into the next move.'],
    readiness: ['PRODUCTION READINESS', 'Verify before autonomy runs.'],
    style: ['SPEAKING STYLE', 'Learn delivery from YouTube videos.'],
    settings: ['CHANNEL GUARDRAILS', 'Make every agent sound like you.']
  };
  $('#view-eyebrow').textContent = titles[view][0];
  $('#view-title').textContent = titles[view][1];
  location.hash = view;
}

async function openContent(productionId) {
  $('#loading').classList.add('active');
  try {
    const item = await api(`/api/content/${encodeURIComponent(productionId)}`);
    const data = item.editorData || {};
    const title = data.title || item.seo?.title || item.script?.title || item.strategy?.topic || 'Untitled content';
    const description = data.description || item.seo?.description || '';
    const tags = data.tags || item.seo?.tags || [];
    const publishTime = data.publishTime || item.schedule?.publish_time || item.scheduled_publish_time;
    const canReview = !['published'].includes(item.schedule?.status);
    const experiment = data.packagingExperiment;
    const selectedTitleVariant = Number(data.selectedTitleVariant || 0);
    const selectedThumbnailVariant = Number(data.selectedThumbnailVariant || 0);
    $('#content-detail').innerHTML = `
      <div class="dialog-heading"><div><p class="eyebrow">CONTENT REVIEW</p><h2>${escapeHTML(title)}</h2><div class="meta-line">${statusChip(item.schedule?.status || item.review_status || item.status)} · Quality ${qualityScore(item.qualityChecks)}%</div></div><button type="button" class="close-button" data-close>×</button></div>
      <div class="content-layout">
        <div>
          <div class="preview">${item.assetUrls.video ? `<video controls preload="metadata" poster="${item.assetUrls.thumbnail || ''}"><source src="${item.assetUrls.video}" type="video/mp4"></video>` : item.assetUrls.thumbnail ? `<img src="${item.assetUrls.thumbnail}" alt="Generated thumbnail">` : '<div class="preview-placeholder">No playable preview was produced.</div>'}</div>
          <div class="quality-grid">${(item.qualityChecks || []).map(check => `<div class="quality-check ${check.passed ? 'pass' : 'fail'}">${check.passed ? '✓' : '×'} ${escapeHTML(check.message)}</div>`).join('') || '<div class="quality-check">No quality results recorded.</div>'}</div>
          ${item.review_notes ? `<p class="callout">${escapeHTML(item.review_notes)}</p>` : ''}
        </div>
        <form id="content-review-form" class="editor">
          <label><span>Title</span><input name="title" maxlength="100" value="${escapeHTML(title)}" required></label>
          <label><span>Description</span><textarea name="description" rows="7">${escapeHTML(description)}</textarea></label>
          <label><span>Tags</span><input name="tags" value="${escapeHTML(tags.join(', '))}"></label>
          ${experiment ? `<section class="experiment-panel">
            <div><p class="eyebrow">APPROVED LEARNING EXPERIMENT</p><strong>${escapeHTML(experiment.hypothesis)}</strong><p>Choose the packaging to ship. Nothing changes on YouTube until this content is approved and published.</p></div>
            <label><span>Title variant</span><select name="selectedTitleVariant">${experiment.titleVariants.map((variant, index) => `<option value="${index}" data-title="${escapeHTML(variant.title)}" ${index === selectedTitleVariant ? 'selected' : ''}>${escapeHTML(variant.label)} — ${escapeHTML(variant.title)}</option>`).join('')}</select></label>
            <div class="experiment-thumbnails">${experiment.thumbnailVariants.map((variant, index) => `<label class="experiment-thumb ${index === selectedThumbnailVariant ? 'selected' : ''}"><input type="radio" name="selectedThumbnailVariant" value="${index}" ${index === selectedThumbnailVariant ? 'checked' : ''}><img src="${escapeHTML(item.assetUrls.experimentThumbnails?.[index] || '')}" alt="${escapeHTML(variant.label)} thumbnail variant"><span>${escapeHTML(variant.label)}</span></label>`).join('')}</div>
          </section>` : ''}
          <div class="form-grid two">
            <label><span>Publish time</span><input name="publishTime" type="datetime-local" value="${toLocalInput(publishTime)}"></label>
            <label><span>Privacy</span><select name="privacyStatus"><option value="private" ${data.privacyStatus === 'private' ? 'selected' : ''}>Private</option><option value="unlisted" ${data.privacyStatus === 'unlisted' ? 'selected' : ''}>Unlisted</option><option value="public" ${data.privacyStatus === 'public' ? 'selected' : ''}>Public</option></select></label>
          </div>
          <div class="settings-row">
            <label class="toggle"><input name="factChecked" type="checkbox" ${data.factChecked ? 'checked' : ''}><span></span> Facts and claims reviewed</label>
            <label class="toggle"><input name="rightsConfirmed" type="checkbox" ${data.rightsConfirmed ? 'checked' : ''}><span></span> Media rights confirmed</label>
          </div>
          ${canReview ? `<div class="form-actions"><button type="button" class="button primary" data-approve-content="${escapeHTML(item.id)}">Approve & schedule</button><button type="button" class="button secondary" data-save-content="${escapeHTML(item.id)}">Save draft</button><button type="button" class="button danger" data-reject-content="${escapeHTML(item.id)}">Reject</button><button type="button" class="button ghost" data-retry-content="${escapeHTML(item.id)}">Regenerate</button></div>` : `<a class="button secondary" href="${escapeHTML(item.schedule?.youtube_url || '#')}" target="_blank" rel="noopener">Open on YouTube</a>`}
        </form>
      </div>`;
    $('#content-dialog').showModal();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    $('#loading').classList.remove('active');
  }
}

function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60000;
  return escapeHTML(new Date(date.getTime() - offset).toISOString().slice(0, 16));
}

function contentFormData() {
  const form = $('#content-review-form');
  const values = Object.fromEntries(new FormData(form));
  return {
    title: values.title,
    description: values.description,
    tags: values.tags,
    publishTime: values.publishTime ? new Date(values.publishTime).toISOString() : undefined,
    privacyStatus: values.privacyStatus,
    selectedTitleVariant: values.selectedTitleVariant,
    selectedThumbnailVariant: values.selectedThumbnailVariant,
    factChecked: form.elements.factChecked?.checked || false,
    rightsConfirmed: form.elements.rightsConfirmed?.checked || false
  };
}

async function mutate(url, method, body, successMessage) {
  $('#loading').classList.add('active');
  try {
    const result = await api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    showToast(successMessage);
    await refreshDashboard(true);
    return result;
  } catch (error) {
    const failures = error.data?.quality?.blockingFailures;
    showToast(failures ? `${error.message}: ${failures.join(', ')}` : error.message, 'error');
    throw error;
  } finally {
    $('#loading').classList.remove('active');
  }
}

document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-view]');
  if (nav) return switchView(nav.dataset.view);
  const go = event.target.closest('[data-go]');
  if (go) return switchView(go.dataset.go);
  if (event.target.closest('[data-close]')) return event.target.closest('dialog').close();

  const open = event.target.closest('[data-open-content]');
  if (open) return openContent(open.dataset.openContent);

  const cancel = event.target.closest('[data-cancel-job]');
  if (cancel && confirm('Cancel this generation job after its current stage?')) {
    await mutate(`/api/jobs/${encodeURIComponent(cancel.dataset.cancelJob)}/cancel`, 'POST', {}, 'Cancellation requested.').catch(() => {});
  }

  const idea = event.target.closest('[data-generate-idea]');
  if (idea) {
    await mutate(`/api/ideas/${encodeURIComponent(idea.dataset.generateIdea)}/generate`, 'POST', { length: 'medium' }, 'Idea queued for generation.').catch(() => {});
  }

  const learning = event.target.closest('[data-learning-action]');
  if (learning) {
    const action = learning.dataset.learningAction;
    const id = learning.dataset.learningId;
    const message = action === 'approve'
      ? 'Learning approved for future autonomous plans.'
      : 'Learning rejected and excluded from future plans.';
    await mutate(`/api/learning/recommendations/${encodeURIComponent(id)}/${action}`, 'POST', {}, message).catch(() => {});
  }

  const save = event.target.closest('[data-save-content]');
  if (save) {
    await mutate(`/api/content/${encodeURIComponent(save.dataset.saveContent)}`, 'PATCH', contentFormData(), 'Draft saved.').catch(() => {});
  }

  const approve = event.target.closest('[data-approve-content]');
  if (approve) {
    try {
      await mutate(`/api/content/${encodeURIComponent(approve.dataset.approveContent)}/approve`, 'POST', contentFormData(), 'Content approved and scheduled.');
      $('#content-dialog').close();
    } catch (_error) { /* toast already shown */ }
  }

  const reject = event.target.closest('[data-reject-content]');
  if (reject) {
    const notes = prompt('Why are you rejecting this content?', 'Needs a different angle');
    if (notes !== null) {
      await mutate(`/api/content/${encodeURIComponent(reject.dataset.rejectContent)}/reject`, 'POST', { notes }, 'Content rejected.').catch(() => {});
      $('#content-dialog').close();
    }
  }

  const retry = event.target.closest('[data-retry-content]');
  if (retry && confirm('Generate a fresh version using the same topic?')) {
    await mutate(`/api/content/${encodeURIComponent(retry.dataset.retryContent)}/retry`, 'POST', {}, 'Regeneration started.').catch(() => {});
    $('#content-dialog').close();
  }
});

document.addEventListener('change', event => {
  if (event.target.matches('[name="selectedTitleVariant"]')) {
    const title = event.target.selectedOptions[0]?.dataset.title;
    const input = $('#content-review-form [name="title"]');
    if (title && input) input.value = title;
  }
});

$('#generate-button').addEventListener('click', () => {
  const language = ui.state?.profile?.default_language || ui.state?.channelStrategy?.default_language || 'hi';
  const select = $('#generate-form [name="language"]');
  if (select) select.value = language;
  const voice = $('#generate-form [name="voice"]');
  if (voice && document.activeElement !== voice) voice.value = ui.state?.profile?.default_voice || '';
  $('#generate-dialog').showModal();
});
$('#add-idea-button').addEventListener('click', () => $('#idea-dialog').showModal());
$('#refresh-button').addEventListener('click', () => refreshDashboard());
$('#pipeline-filter').addEventListener('change', () => renderPipeline(ui.state?.pipeline || []));

$('#run-readiness-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Running live checks…';
  try {
    await mutate('/api/readiness/run', 'POST', { includePaidMedia: $('#paid-image-probe').checked }, 'Production readiness check completed.');
    switchView('readiness');
  } catch (_error) { /* toast already shown */ }
  finally {
    button.disabled = false;
    button.textContent = 'Run verified check';
  }
});

$('#automation-toggle').addEventListener('click', async () => {
  const action = ui.state?.system.automationPaused ? 'resume' : 'pause';
  await mutate(`/api/automation/${action}`, 'POST', {}, `Automation ${action}d.`).catch(() => {});
});

function strategyFormData(status = ui.state?.channelStrategy?.status || 'draft') {
  const form = $('#strategy-form');
  const values = Object.fromEntries(new FormData(form));
  return {
    ...values,
    contentPillars: values.contentPillars.split(',').map(value => value.trim()).filter(Boolean),
    cadencePerWeek: Number(values.cadencePerWeek),
    videosPerRun: Number(values.videosPerRun),
    status
  };
}

$('#strategy-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await mutate('/api/operator/strategy', 'PUT', strategyFormData(), 'Channel strategy saved.');
    clearFormDirty(event.currentTarget);
  } catch (_error) { /* toast already shown */ }
});

$('#activate-operator-button').addEventListener('click', async () => {
  if (!$('#strategy-form').reportValidity()) return;
  await mutate('/api/operator/start', 'POST', strategyFormData('active'), 'Autonomous operator started.').catch(() => {});
});

$('#pause-operator-button').addEventListener('click', async () => {
  await mutate('/api/operator/pause', 'POST', {}, 'Autonomous operator paused.').catch(() => {});
});

$('#cancel-operator-run').addEventListener('click', async event => {
  const runId = event.currentTarget.dataset.runId;
  if (runId && confirm('Stop this autonomous run after the current agent stage?')) {
    await mutate(`/api/operator/runs/${encodeURIComponent(runId)}/cancel`, 'POST', {}, 'Operator stop requested.').catch(() => {});
  }
});

$('#generate-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await mutate('/generate', 'POST', {
      topic: values.topic.trim() || null,
      style: values.style,
      length: values.length,
      language: values.language,
      voice: String(values.voice || '').trim() || null
    }, 'Generation job started.');
    $('#generate-dialog').close();
    event.currentTarget.reset();
  } catch (_error) { /* toast already shown */ }
});

$('#idea-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await mutate('/api/ideas', 'POST', values, 'Idea added to the backlog.');
    $('#idea-dialog').close();
    event.currentTarget.reset();
  } catch (_error) { /* toast already shown */ }
});

$('#speaking-style-form').addEventListener('input', markFormDirty);
$('#speaking-style-form').addEventListener('change', markFormDirty);
$('#speaking-style-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const urls = ['url1', 'url2', 'url3', 'url4', 'url5']
    .map(name => String(values[name] || '').trim())
    .filter(Boolean);
  try {
    await mutate('/api/speaking-style/learn', 'POST', {
      urls,
      language: values.language
    }, 'Learning speaking style from those videos…');
    clearFormDirty(event.currentTarget);
  } catch (_error) { /* toast already shown */ }
});

$('#speaking-style-enabled').addEventListener('change', async event => {
  await mutate('/api/speaking-style', 'PUT', { enabled: event.currentTarget.checked },
    event.currentTarget.checked ? 'Next scripts will use the learned style.' : 'Speaking style turned off for new scripts.'
  ).catch(() => {});
});

$('#youtube-form').addEventListener('input', markFormDirty);
$('#youtube-form').addEventListener('change', markFormDirty);
$('#youtube-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await mutate('/api/youtube', 'PUT', {
      clientId: String(values.clientId || '').trim(),
      clientSecret: String(values.clientSecret || '').trim()
    }, 'YouTube client saved.');
    event.currentTarget.elements.clientSecret.value = '';
    clearFormDirty(event.currentTarget);
  } catch (_error) { /* toast already shown */ }
});

$('#youtube-connect-button').addEventListener('click', async () => {
  try {
    const form = $('#youtube-form');
    const clientId = String(form.elements.clientId.value || '').trim();
    const clientSecret = String(form.elements.clientSecret.value || '').trim();
    if (clientId && clientSecret) {
      await api('/api/youtube', { method: 'PUT', body: JSON.stringify({ clientId, clientSecret }) });
      form.elements.clientSecret.value = '';
      clearFormDirty(form);
    }
    const result = await api('/api/youtube/connect', { method: 'POST', body: '{}' });
    if (!result.authUrl) throw new Error('Google did not return a sign-in URL');
    window.open(result.authUrl, 'youtube-oauth', 'width=520,height=720');
    showToast('Finish Google sign-in in the popup, then return here.');
    const started = Date.now();
    while (Date.now() - started < 180000) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const status = await api('/api/youtube');
      if (status.connected) {
        if (ui.state) {
          ui.state.youtube = status;
          ui.state.system.youtubeReady = true;
        }
        renderYouTubeSettings(status);
        showToast('YouTube connected.');
        return;
      }
    }
    showToast('Still waiting. Refresh Channel setup after you approve access.', 'error');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

$('#youtube-disconnect-button').addEventListener('click', async () => {
  if (!confirm('Disconnect YouTube from this operator? Uploads will stop until you connect again.')) return;
  await mutate('/api/youtube/disconnect', 'POST', {}, 'YouTube disconnected.').catch(() => {});
});

$('#profile-form').addEventListener('input', markFormDirty);
$('#profile-form').addEventListener('change', markFormDirty);
$('#strategy-form').addEventListener('input', markFormDirty);
$('#strategy-form').addEventListener('change', markFormDirty);

$('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  values.bannedTopics = values.bannedTopics.split(',').map(value => value.trim()).filter(Boolean);
  values.defaultVoice = String(values.defaultVoice || '').trim();
  try {
    await mutate('/api/profile', 'PUT', values, 'Channel setup saved.');
    clearFormDirty(event.currentTarget);
    await mutate('/api/settings', 'PUT', {
      approval_required: $('#approval-required').checked,
      notification_enabled: $('#notifications-enabled').checked,
      channel_timezone: values.timezone
    }, 'Operator settings saved.');
  } catch (_error) { /* toast already shown */ }
});

$('#api-key-button').addEventListener('click', () => {
  if (requestApiKey() !== null) showToast('Dashboard API key saved in this browser.');
});

const initialView = location.hash.slice(1);
if (['overview', 'operator', 'pipeline', 'calendar', 'analytics', 'readiness', 'style', 'settings'].includes(initialView)) switchView(initialView);
refreshDashboard();
setInterval(() => refreshDashboard(true), 8000);
