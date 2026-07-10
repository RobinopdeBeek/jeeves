/* =========================================================================
   JEEVES board + issue page — shared logic.
   Loaded by both board-jeeves.html and issue.html (plain <script src>).
   Owns: data, localStorage persistence, render-string builders, mutations.
   Each page registers hooks on `App` for page-specific navigation/repaint.
   step.status: 'done' | 'ai-working' | 'needs-user' | 'queued' | 'pending'
   ========================================================================= */

/* ---------- persistence ---------- */
const STORAGE_KEY = 'jeeves-cards-v1';

function seedCards() {
  return [
    // ---- Backlog (kind undecided until the user picks Grill me / Implement) ----
    { id: 'b1', col: 'backlog', kind: null, title: 'Offline workout logging', desc: 'Queue logs locally, sync when back online.', branch: null, steps: mk(null, 'backlog') },
    { id: 'b2', col: 'backlog', kind: null, title: 'Apple Health import', desc: 'Pull historical workouts on first connect.', branch: null, steps: mk(null, 'backlog') },

    // ---- Features in Define ----
    // s1: mid-implementation. Tasks orange, "Implementing Task 3 of 5".
    {
      id: 's1', col: 'shape', kind: 'feature', title: 'Add workout streaks', desc: 'Habit hook: streak counter on home + profile.',
      branch: 'feat/streaks', implProgress: { cur: 3, total: 5 },
      steps: mk('feature', 'shape', { grill: 'done', prd: 'done', tasks: 'ai-working' })
    },
    // s2: task list generated, awaiting user confirm. Tasks blue.
    {
      id: 's2', col: 'shape', kind: 'feature', title: 'Social sharing of PRs', desc: 'Share a personal-record card to socials.',
      branch: 'feat/pr-share',
      draftTasks: [
        { title: 'PR-share card renderer', desc: 'Render a shareable image of a PR.' },
        { title: 'Share sheet integration', desc: 'Hook into OS share sheet + copy link.' },
        { title: 'Deep-link inbound routing', desc: 'Land on the PR from a shared link.' },
      ],
      steps: mk('feature', 'shape', { grill: 'done', prd: 'done', tasks: 'needs-user' })
    },

    // ---- Child tasks of s1 (Implement column) ----
    {
      id: 't3', col: 'implement', kind: 'task-child', parent: 's1', title: 'Streak calc API', desc: 'Timezone-aware current/longest streak endpoint.',
      branch: 'feat/streaks/card-3', steps: mk('task-child', 'implement', { plan: 'done', impl: 'ai-working', airev: 'queued' })
    },
    {
      id: 't4', col: 'implement', kind: 'task-child', parent: 's1', title: 'Streak UI badge', desc: 'Flame badge on home + profile header.',
      branch: 'feat/streaks/card-4', steps: mk('task-child', 'implement', { plan: 'queued', impl: 'pending', airev: 'pending' })
    },
    {
      id: 't5', col: 'implement', kind: 'task-child', parent: 's1', title: 'Streak push notifications', desc: 'Daily streak-reminder push.',
      branch: 'feat/streaks/card-5', steps: mk('task-child', 'implement', { plan: 'queued', impl: 'pending', airev: 'pending' })
    },

    // ---- Standalone task (Implement) — no parent, will reach Finalize ----
    {
      id: 'st1', col: 'implement', kind: 'task-standalone', title: 'Rest timer overhaul', desc: 'Configurable rest timers between sets.',
      branch: 'fix/rest-timer', steps: mk('task-standalone', 'implement', { plan: 'done', impl: 'done', airev: 'queued' })
    },

    // ---- Child task in Human Review (already merged its impl) ----
    {
      id: 'r1', col: 'review', kind: 'task-child', parent: 's1', title: 'Streak onboarding copy', desc: 'First-streak celebratory message.',
      branch: 'feat/streaks/card-1', flags: 1, evalReady: true, steps: mk('task-child', 'review', { review: 'needs-user' }),
      qa: [true, false, false],
      changeRequests: [
        { id: 'cr-r1a', text: 'Tone down the emoji — a single 🔥, not three.' },
        { id: 'cr-r1b', text: 'Add a fallback string for users with no streak yet.' },
      ],
    },

    // ---- Feature in Human Review (all children merged) — one coherent eval plan ----
    // draftTasks record the 4 original slices; when "Create tasks" is clicked
    // they're archived as read-only "Round 1" artifacts in the Tasks tab.
    {
      id: 'fr1', col: 'review', kind: 'feature', title: 'Onboarding revamp', desc: 'Trim signup to 2 steps, add progress hint.',
      branch: 'feat/onboarding', flags: 3, evalReady: true, childCount: 4,
      steps: mk('feature', 'review', { grill: 'done', prd: 'done', tasks: 'done', review: 'needs-user' }),
      qa: [true, false, false],
      draftTasks: [
        { title: 'Signup form collapse', desc: 'Reduce the signup form from 5 steps to 2.' },
        { title: 'Progress hint component', desc: 'Stepper-style hint visible on every step.' },
        { title: 'Signup analytics events', desc: 'Emit one event per step, dedup after merge.' },
        { title: 'Onboarding copy revision', desc: 'Rewrite copy for the 2-step flow.' },
      ],
      changeRequests: [
        { id: 'cr-fr1a', text: 'Step 2 still asks for phone — PRD said email-only signup.' },
      ],
    },

    // ---- Feature in Finalize ----
    {
      id: 'f1', col: 'finalize', kind: 'feature', title: 'Profile redesign', desc: 'New profile layout with stat cards.',
      branch: 'feat/profile', steps: mk('feature', 'finalize', { document: 'ai-working', deploy: 'queued' })
    },
  ];
}

function loadCards() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* fall through to seed */ }
  return seedCards();
}
function saveCards() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(CARDS)); } catch (e) { /* ignore quota */ }
}
function resetCards() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { }
  CARDS = seedCards();
  nextCardId = computeNextCardId();
}

/* ---------- data ---------- */
const COLUMNS = [
  { id: 'backlog',    name: 'Backlog',         short: 'Backlog',    sub: 'Captured ideas, not started' },
  { id: 'shape',      name: 'Define Feature',  short: 'Define',     sub: 'Features: Grill → PRD → Tasks' },
  { id: 'implement',  name: 'Implement Task',  short: 'Implement',  sub: 'Tasks: Plan → Implement → AI Review' },
  { id: 'review',     name: 'Human Review',    short: 'Review',     sub: 'Your call before merge' },
  { id: 'finalize',   name: 'Finalize',        short: 'Finalize',   sub: 'Document → Deploy' },
];

/* Per-kind pipelines. Every pipeline starts with 'backlog' so the Info tab
   (title + description) is always present. A card accumulates the steps of
   every stage it has reached along its own pipeline. */
const PIPELINES = {
  feature: ['backlog', 'shape', 'review', 'finalize'],
  'task-child': ['backlog', 'implement', 'review'],
  'task-standalone': ['backlog', 'implement', 'review', 'finalize'],
};
const pipelineOf = card => card.kind ? PIPELINES[card.kind] : ['backlog'];

const STAGE_STEPS = {
  backlog: [['info', 'Info', 'info']],
  shape: [['grill', 'Grill', 'chat'], ['prd', 'PRD', 'ai'], ['tasks', 'Tasks', 'ai']],
  implement: [['plan', 'Plan', 'ai'], ['impl', 'Implement', 'ai'], ['airev', 'AI Review', 'ai']],
  review: [['review', 'Human Review', 'human']],
  finalize: [['document', 'Document', 'ai'], ['deploy', 'Deploy', 'ai']],
};

/* Build the cumulative step list for a card on `pipeline` sitting in `col`.
   statusMap maps a step key → status; anything unset defaults to 'pending'. */
function buildSteps(pipeline, col, statusMap = {}) {
  const upto = pipeline.indexOf(col);
  const steps = [];
  for (let i = 0; i <= upto; i++) {
    for (const [key, label, kind] of STAGE_STEPS[pipeline[i]]) {
      steps.push({ key, label, kind, stage: pipeline[i], status: statusMap[key] || 'pending' });
    }
  }
  return steps;
}

/* Convenience: every step up to `col` defaults to 'done', then apply overrides. */
function mk(kind, col, overrides = {}) {
  const pipeline = kind ? PIPELINES[kind] : ['backlog'];
  const map = {};
  buildSteps(pipeline, col).forEach(s => map[s.key] = 'done');
  Object.assign(map, overrides);
  return buildSteps(pipeline, col, map);
}

let CARDS = loadCards();
function computeNextCardId() {
  let max = 100;
  for (const c of CARDS) {
    const n = parseInt(String(c.id).replace(/\D/g, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max;
}
let nextCardId = computeNextCardId();

const cardById = id => CARDS.find(c => c.id === id);
const cardsInCol = id => CARDS.filter(c => c.col === id);
const childrenOf = card => CARDS.filter(c => c.parent === card.id);
/* 1-based position of a child task within its parent feature's task list.
   Matches the numbering the draft-task cards show (1., 2., 3., …). */
function taskNumber(card) {
  if (card.kind !== 'task-child' || !card.parent) return null;
  const idx = childrenOf(cardById(card.parent)).findIndex(c => c.id === card.id);
  return idx >= 0 ? idx + 1 : null;
}

/* =========================================================================
   HELPERS
   ========================================================================= */
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMd(raw) {
  if (!raw || !raw.trim()) return '<span style="color:var(--muted-foreground);font-style:italic">Nothing to preview.</span>';
  let s = esc(raw);
  s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  s = s.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*?<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  s = s.split(/\n\n+/).map(p => {
    p = p.trim();
    if (!p) return '';
    if (/^<(h[1-6]|ul|ol|pre|li)/.test(p)) return p;
    return `<p>${p.replace(/\n/g, ' ')}</p>`;
  }).join('');
  return s;
}

/* "Work" steps = everything except the always-present Info tab. */
const workSteps = card => card.steps.filter(s => s.kind !== 'info');
function flagSvg(size, color) {
  return `<svg class="flag-ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`;
}
const needsUser = card => workSteps(card).some(s => s.status === 'needs-user') || card.col === 'review';
const activeStep = card => {
  const w = workSteps(card);
  return w.find(s => s.status === 'ai-working' || s.status === 'needs-user')
    || w.find(s => s.status === 'pending')
    || w[w.length - 1];
};
/* Index (into the full card.steps array) the issue view should open on. */
const dialogStartIndex = card => {
  const a = activeStep(card);
  return a ? card.steps.indexOf(a) : 0; // 0 = Info tab
};

/* Stable accent colour per parent feature, for subtle grouping in Implement. */
const ACCENTS = ['oklch(0.62 0.19 256)', 'oklch(0.70 0.16 70)', 'oklch(0.62 0.17 150)', 'oklch(0.65 0.15 300)', 'oklch(0.6 0.18 0)', 'oklch(0.55 0.14 200)'];
function accentFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return ACCENTS[h % ACCENTS.length];
}

/* =========================================================================
   SHARED RENDER PIECES
   ========================================================================= */
function stepIcon(status) {
  if (status === 'done') return `<span class="check">✓</span>`;
  if (status === 'ai-working') return `<span class="spin"></span>`;
  if (status === 'needs-user') return `<span class="ring-user"></span>`;
  if (status === 'queued') return `<span class="ring-queued"></span>`;
  return `<span class="ring-empty"></span>`;
}
function segSegClass(status) {
  return { done: 'done', 'ai-working': 'ai', 'needs-user': 'user', queued: 'queued' }[status] || '';
}
function segTipIcon(status) {
  if (status === 'done') return `<span class="seg-tip-ic done">✓</span>`;
  if (status === 'ai-working') return `<span class="seg-tip-ic ai"><span class="spin"></span></span>`;
  if (status === 'needs-user') return `<span class="seg-tip-ic user"></span>`;
  if (status === 'queued') return `<span class="seg-tip-ic queued"></span>`;
  return `<span class="seg-tip-ic todo"></span>`;
}
function segBar(card) {
  const steps = card.steps.filter(s => s.kind !== 'info' && s.stage === card.col);
  if (!steps.length) return '';
  return `<div class="seg">${steps.map(s =>
    `<span class="seg-seg ${segSegClass(s.status)}" tabindex="0">
      <span class="seg-tip">${segTipIcon(s.status)}${s.label}${s.status === 'queued' ? ' <span class="muted">(in queue)</span>' : ''}</span>
    </span>`).join('')}</div>`;
}

function cardMeta(card) {
  return `<div class="ov-meta">
    ${card.branch ? `<span>⎇ ${card.branch}</span>` : '<span>no branch yet</span>'}
    <span>tokens 184k</span><span>cost $2.41</span><span>composer-2.5</span></div>`;
}

/* ---- Insights modal (replaces the old inline ov-meta line) ---- */
const INS_FOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>`;

function insightsHtml(card) {
  const done = card.steps.filter(s => s.status === 'done').length;
  const total = card.steps.length;
  const row = (label, val) => `<div class="ins-row"><span class="ins-k">${label}</span><span class="ins-v">${val}</span></div>`;
  return `<div class="ins-body">
    ${row('Branch', card.branch ? `⎇ ${esc(card.branch)}` : '<span class="muted">no branch yet</span>')}
    ${row('Model', 'composer-2.5')}
    ${row('Tokens', '184k')}
    ${row('Cost', '$2.41')}
    ${row('Progress', `${done} / ${total} steps done`)}
    ${row('Kind', esc(card.kind || '—'))}
  </div>
  <button class="ins-artifacts-link" type="button" onclick="openArtifactsFolder('${esc(card.id)}')" title="Open this card's artifacts folder">
    ${INS_FOLDER_SVG}<span>Open artifacts folder</span>
  </button>
  <div class="ins-foot muted">More insights (tokens by step, run history, diffs) will appear here.</div>`;
}

/* In production this opens data/cards/<id>/ in Finder/Explorer on the host,
   or the /artifacts/<id> HTTP listing when accessed remotely (phone/tablet). */
function openArtifactsFolder(cardId) {
  alert('PROTOTYPE: opens the artifacts folder for card ' + cardId +
    ' (Finder/Explorer on the host, or the /artifacts/' + cardId + ' HTTP listing remotely)');
}

function openInsights(cardId) {
  const card = cardById(cardId);
  if (!card) return;
  if (document.querySelector('.insights-modal')) return;
  const overlay = document.createElement('div');
  overlay.className = 'insights-modal';
  overlay.innerHTML = `<div class="insights-card" role="dialog" aria-modal="true" aria-label="Insights">
    <div class="insights-head">
      <b>Insights</b>
      <button class="x" type="button" onclick="closeInsights()" title="Close" aria-label="Close">✕</button>
    </div>
    ${insightsHtml(card)}
  </div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeInsights(); });
  document.body.appendChild(overlay);
}

function closeInsights() {
  document.querySelectorAll('.insights-modal').forEach(m => m.remove());
}

/* ---- mock work area for a given sub-step ---- */
function workArea(card, step) {
  if (!step) return `<div class="muted">Nothing active.</div>`;
  const T = step.key;
  if (T === 'grill') {
    const locked = (card.steps.find(s => s.key === 'grill') || {}).status === 'done';
    return `<div class="panel chat-panel"><div class="chat">
      <div class="bub ai">What's the single hardest constraint on streaks?</div>
      <div class="bub me">Timezones — must reset at the user's local midnight, from the device.</div>
      <div class="bub ai">Got it. I'll flag "DST transition day" for the QA plan. Logout-everywhere behaviour?</div>
    </div>
    ${locked ? '' : `<div class="composer">
      <button class="attach-btn" type="button" title="Attach files" aria-label="Attach files" onclick="attachFile(this)">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <textarea class="composer-input" rows="1" placeholder="Message… (Enter to send)"
        oninput="autoGrow(this)" onkeydown="composerKey(event)"></textarea>
    </div>`}</div>`;
  }
  if (T === 'prd') {
    const prd = card.prd || `# ${esc(card.title || 'Untitled')}

## Overview
Track consecutive-day workout streaks and surface them in the product.

## Acceptance criteria
- [ ] Streak = consecutive days with ≥1 logged workout
- [ ] Resets at device-local midnight
- [ ] Shown on home + profile

## Non-goals
- No social/leaderboard streaks in this iteration

## Open questions
- DST transition day handling?
- Logout-everywhere behaviour?
`;
    const prdDone = (card.steps.find(s => s.key === 'prd') || {}).status === 'done';
    return `<div class="prd-layout">
      <div class="prd-editor">
        <textarea class="ed prd-ed" id="prd-doc" oninput="autoSavePrd()"
          ${prdDone ? 'readonly' : ''}
          placeholder="Write the PRD in markdown…">${esc(prd)}</textarea>
      </div>
      ${prdDone ? '' : `<aside class="prd-side">
        <div class="chat">
          <div class="bub ai">Want me to draft acceptance criteria from your grill notes?</div>
          <div class="bub me">Yes — and flag any edge cases around timezones.</div>
          <div class="bub ai">Added 3 criteria + an "open questions" section. Check the editor →</div>
        </div>
        <div class="composer">
          <button class="attach-btn" type="button" title="Attach files" aria-label="Attach files" onclick="attachFile(this)">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <textarea class="composer-input" rows="1" placeholder="Ask or request changes… (Enter to send)"
            oninput="autoGrow(this)" onkeydown="composerKey(event)"></textarea>
        </div>
      </aside>`}
    </div>`;
  }
  if (T === 'tasks') return tasksArea(card);
  if (T === 'plan') return `<div class="panel doc"><h4>Implementation plan</h4><ul><li>Add <code>GET /api/streaks/:userId</code></li><li>Pure <code>computeStreak()</code> in domain layer</li><li>Unit tests for tz boundaries</li></ul></div>`;
  if (T === 'impl') return `<div class="runlog">
      <div class="t">[12:04:01] worktree ${esc(card.branch)} ready</div>
      <div class="ok">[12:04:03] ✓ cursor("composer-2.5") session started</div>
      <div>[12:04:31] writing domain/streak.ts</div>
      <div class="warn">[12:05:02] ⚠ adding date-fns-tz for DST handling</div>
      <div>[12:05:58] running vitest …</div>
      <div><span class="spin" style="display:inline-block;vertical-align:-2px"></span> running…</div></div>`;
  if (T === 'airev') return `<div class="panel findings">
      <div class="f"><span class="badge badge-destructive">Major</span><span>No test for DST transition day — streak may double-count.</span></div>
      <div class="f"><span class="badge badge-secondary">Minor</span><span>computeStreak() reads Date.now() directly — inject a clock.</span></div>
      <div class="f"><span class="badge badge-outline">Suggestion</span><span>Memoise per user; recompute on new log only.</span></div></div>`;
  if (T === 'review') return card.kind === 'feature' ? featureReviewArea(card) : taskReviewArea(card);
  if (T === 'document') return `<div class="panel doc"><h4>Docs updated</h4><ul><li>README: streaks feature section</li><li>ADR-014: device-local reset decision</li></ul></div>`;
  if (T === 'deploy') return `<div class="runlog"><div class="ok">[deploy] ✓ PR feat/onboarding → main opened</div><div class="t">[deploy] awaiting CI…</div></div>`;
  return `<div class="muted">—</div>`;
}

/* Default E2E vertical-slice drafts for a feature. Rich enough to inspect/edit. */
function defaultDraftTasks(card) {
  const t = card.title || 'Feature';
  return [
    {
      title: `${t} — API`, desc: 'Backend slice: expose the streak endpoint + domain logic.',
      criteria: ['GET /api/streaks/:userId returns current streak', 'Reset computed at device-local midnight', 'DST transition day does not double-count'],
      files: ['api/streaks.ts', 'domain/streak.ts', 'api/streaks.test.ts']
    },
    {
      title: `${t} — UI`, desc: 'Frontend slice: render the streak on home + profile.',
      criteria: ['Streak badge on home screen', 'Streak count on profile', 'Updates after a logged workout'],
      files: ['components/StreakBadge.tsx', 'pages/Profile.tsx', 'hooks/useStreak.ts']
    },
    {
      title: `${t} — tests`, desc: 'Cross-cutting test coverage for the slices above.',
      criteria: ['Unit tests for tz boundaries', 'E2E: log workout → streak increments', 'Regression: DST day reset'],
      files: ['e2e/streak.spec.ts', 'domain/streak.test.ts']
    },
  ];
}

function draftCardHtml(card, d, idx) {
  const trash = `<button class="task-del" type="button" title="Delete task" aria-label="Delete task"
    onclick="event.stopPropagation();deleteDraftTask('${card.id}',${idx})">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
  </button>`;
  return `<div class="card" onclick="openDraftTask('${card.id}',${idx})">
    <div class="card-pad">
      <div class="card-top"><span class="card-title">${idx + 1}. ${esc(d.title) || '<em style="color:var(--muted-foreground)">Untitled task</em>'}</span>${trash}</div>
      <div class="card-desc">${esc(d.desc) || ''}</div>
    </div>
  </div>`;
}

/* Read-only rendering of a prior round's draft tasks (the merged slices from
   before a rework). No trash, no click-to-edit, tinted to look archived. */
function archivedDraftHtml(d, idx) {
  return `<div class="card archived-card">
    <div class="card-pad">
      <div class="card-top"><span class="card-title">${idx + 1}. ${esc(d.title) || '<em>Untitled task</em>'}</span><span class="archived-tag">merged ✓</span></div>
      <div class="card-desc">${esc(d.desc || '')}</div>
    </div>
  </div>`;
}

/* Prior rounds, each a collapsible <details> group. Most recent round first. */
function archivedTasksHtml(card) {
  const rounds = card.archivedTasks || [];
  if (!rounds.length) return '';
  const sorted = [...rounds].sort((a, b) => b.round - a.round);
  return sorted.map(r => `<details class="archived-round">
    <summary class="archived-round-head">
      <span class="archived-chev">▾</span> Round ${r.round} tasks <span class="muted">(${r.tasks.length} merged ✓)</span>
    </summary>
    <div class="tasks-list archived-list">${r.tasks.map((d, i) => archivedDraftHtml(d, i)).join('')}</div>
  </details>`).join('');
}

function tasksLeft(card, step) {
  if (step.status === 'needs-user') {
    const drafts = card.draftTasks || (card.draftTasks = defaultDraftTasks(card), card.draftTasks);
    const list = drafts.map((d, idx) => draftCardHtml(card, d, idx)).join('');
    const reworkHead = (card.reworkRound || 0) > 0
      ? `<div class="tasks-section-label">Rework tasks — from your change requests</div>`
      : '';
    return `${archivedTasksHtml(card)}${reworkHead}<div class="tasks-list">${list}</div>`;
  }
  if (step.status === 'ai-working') {
    const kids = childrenOf(card);
    // Board-style cards; tasks that need your eye (human review) float to top.
    const sorted = [...kids].sort((a, b) => Number(needsUser(b)) - Number(needsUser(a)));
    return `<div class="tasks-list">${sorted.map(renderCard).join('')}</div>`;
  }
  // Tasks complete: keep the headline, drop the descriptive paragraph, and
  // still show the tasks. Children are gone (merged & removed at completeTasks),
  // so the current round comes from card.draftTasks rendered read-only; any
  // earlier rework rounds come from card.archivedTasks (collapsed above).
  const drafts = card.draftTasks || [];
  const prior = (card.archivedTasks || []).length > 0;
  const thisRoundLabel = prior ? `<div class="tasks-section-label">This round</div>` : '';
  const thisRound = drafts.length
    ? `${thisRoundLabel}<div class="tasks-list archived-list">${drafts.map((d, i) => archivedDraftHtml(d, i)).join('')}</div>`
    : '';
  return `<div class="tasks-complete-banner"><span class="tasks-complete-emoji">🎉</span> Tasks complete</div>${archivedTasksHtml(card)}${thisRound}`;
}

function tasksArea(card) {
  const step = card.steps.find(s => s.key === 'tasks');
  const count = (card.draftTasks || []).length;
  const fab = step.status === 'needs-user'
    ? `<button class="btn btn-outline fab" type="button" onclick="addDraftTask('${card.id}')" title="Add task">+ Add task</button>`
    : '';
  const rework = (card.reworkRound || 0) > 0;
  const aiBubble = rework
    ? `<div class="bub ai">Here${count === 1 ? "'s" : ' are'} ${count || 'the'} rework task${count === 1 ? '' : 's'} from your change request${count === 1 ? '' : 's'}. Tweak them, or tell me what to adjust.</div>`
    : `<div class="bub ai">I've broken the feature into ${count || 'a few'} end-to-end slices. Click any task to inspect or edit it.</div>`;
  // During implementation (ai-working) the sidepanel isn't useful — the work
  // is happening on the child task cards, not in this chat. Hide it so the
  // task list gets the full width. Also hide it once tasks are done — there's
  // nothing to ask the AI about until the feature is re-reviewed.
  const side = (step.status === 'ai-working' || step.status === 'done') ? '' : `<aside class="prd-side">
      <div class="chat">
        ${aiBubble}
        ${rework ? '' : `<div class="bub me">Make the API slice cover the DST edge case too.</div>
        <div class="bub ai">Done — added a criterion and a test file to that slice.</div>`}
      </div>
      <div class="composer">
        <button class="attach-btn" type="button" title="Attach files" aria-label="Attach files" onclick="attachFile(this)">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <textarea class="composer-input" rows="1" placeholder="Ask or request changes… (Enter to send)"
          oninput="autoGrow(this)" onkeydown="composerKey(event)"></textarea>
      </div>
    </aside>`;
  return `<div class="prd-layout">
    <div class="prd-editor tasks-left">
      <div class="tasks-scroll">${tasksLeft(card, step)}</div>
      ${fab}
    </div>
    ${side}
  </div>`;
}

/* ---- Draft task inspector/editor (modal) ---- */
function openDraftTask(cardId, idx) {
  const card = cardById(cardId); if (!card) return;
  const drafts = card.draftTasks || [];
  const d = drafts[idx] || { title: '', desc: '', criteria: [], files: [], blockedBy: [] };
  const others = drafts.map((dd, i) => ({ i, dd })).filter(o => o.i !== idx);
  const blockedSection = others.length
    ? `<div class="issue-field" style="margin-bottom:12px">
        <label class="sec-label">Blocked by</label>
        <div class="blk-row" id="blk-row">${renderBlockedRow(cardId, idx)}</div>
      </div>`
    : '';
  const overlay = document.createElement('div');
  overlay.className = 'insights-modal';
  overlay.innerHTML = `<div class="insights-card insights-card--wide" role="dialog" aria-modal="true" aria-label="Edit task">
    <div class="insights-head"><b>Edit task ${idx + 1}</b>
      <button class="x" type="button" onclick="closeInsights()" title="Close" aria-label="Close">✕</button></div>
    <div class="ins-body">
      <div class="issue-field" style="margin-bottom:12px">
        <label class="sec-label" for="draft-title">Title</label>
        <input class="issue-input" id="draft-title" value="${esc(d.title)}" placeholder="Task title…" autocomplete="off">
      </div>
      ${blockedSection}
      <div class="issue-field" style="margin-bottom:4px">
        <label class="sec-label" for="draft-desc">Description</label>
        <textarea class="ed" id="draft-desc" style="min-height:90px" placeholder="What this slice delivers…">${esc(d.desc || '')}</textarea>
      </div>
    </div>
    <div class="ins-foot" style="display:flex;gap:8px;justify-content:flex-end;align-items:center">
      ${drafts.length > 1 ? `<button class="btn btn-delete btn-sm" style="margin-right:auto" onclick="deleteDraftTask('${cardId}',${idx})">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        Delete</button>` : ''}
      <button class="btn btn-outline btn-sm" onclick="closeInsights()">Cancel</button>
      <button class="btn btn-primary btn-sm" onclick="saveDraftTask('${cardId}',${idx})">Save</button>
    </div>
  </div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeInsights(); });
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('draft-title')?.focus(), 30);
}

/* Persist the modal's Title/Description into the draft without closing it
   (used before navigating between tasks or toggling blockers). */
function persistDraftForm(cardId, idx) {
  const card = cardById(cardId); if (!card) return;
  card.draftTasks = card.draftTasks || [];
  const prev = card.draftTasks[idx] || {};
  card.draftTasks[idx] = {
    title: document.getElementById('draft-title')?.value || '',
    desc: document.getElementById('draft-desc')?.value || '',
    criteria: prev.criteria || [],
    files: prev.files || [],
    blockedBy: prev.blockedBy || [],
  };
  saveCards();
}

function saveDraftTask(cardId, idx) {
  persistDraftForm(cardId, idx);
  closeInsights();
  App.repaintIssue();
}

/* Inner HTML for the blocked-by row (pills + add dropdown). Reused so toggling
   a blocker can refresh just this row without reopening the whole modal. */
function renderBlockedRow(cardId, idx) {
  const card = cardById(cardId); if (!card) return '';
  const drafts = card.draftTasks || [];
  const d = drafts[idx] || {};
  const blockedBy = d.blockedBy || [];
  const others = drafts.map((dd, i) => ({ i, dd })).filter(o => o.i !== idx);
  const blockedPills = blockedBy.map(i => {
    const dd = drafts[i]; if (!dd) return '';
    return `<span class="blk-pill on" onclick="switchDraftTask('${cardId}',${idx},${i})" title="Open task ${i + 1}">
      ${i + 1}. ${esc(dd.title || 'Untitled')}
      <button class="blk-x" type="button" onclick="event.stopPropagation();toggleBlocker('${cardId}',${idx},${i})" title="Remove blocker" aria-label="Remove blocker">✕</button>
    </span>`;
  }).join('');
  const addItems = others.filter(o => !blockedBy.includes(o.i)).map(o =>
    `<div class="blk-item" onclick="toggleBlocker('${cardId}',${idx},${o.i},true)">${o.i + 1}. ${esc(o.dd.title || 'Untitled')}</div>`).join('');
  return `${blockedPills}<span class="blk-add">
    <button class="blk-add-btn" type="button" onclick="toggleBlockerDropdown(this)" title="Add blocker" aria-label="Add blocker">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <div class="blk-dropdown">${addItems || '<div class="blk-empty">No other tasks</div>'}</div>
  </span>`;
}

/* Toggle whether task `idx` is blocked by task `blockerIdx`. Refreshes just the
   blocked-by row in place; only reopens the modal when navigating to another task. */
function toggleBlocker(cardId, idx, blockerIdx, keepDropdownOpen) {
  const card = cardById(cardId); if (!card) return;
  card.draftTasks = card.draftTasks || [];
  const d = card.draftTasks[idx] || (card.draftTasks[idx] = { title: '', desc: '', criteria: [], files: [], blockedBy: [] });
  d.blockedBy = d.blockedBy || [];
  const pos = d.blockedBy.indexOf(blockerIdx);
  if (pos >= 0) d.blockedBy.splice(pos, 1); else d.blockedBy.push(blockerIdx);
  persistDraftForm(cardId, idx);
  const row = document.getElementById('blk-row');
  if (!row) return;
  row.innerHTML = renderBlockedRow(cardId, idx);
  if (keepDropdownOpen) {
    const btn = row.querySelector('.blk-add-btn');
    if (btn) openBlockerDropdown(btn);
  }
}

/* From the current task modal, jump into another task's modal (saving edits first). */
function switchDraftTask(cardId, fromIdx, toIdx) {
  persistDraftForm(cardId, fromIdx);
  closeInsights();
  openDraftTask(cardId, toIdx);
}

/* "Add blocker" dropdown: open + outside-click handling. */
function openBlockerDropdown(btn) {
  const wrap = btn.closest('.blk-add'); if (!wrap) return;
  const dd = wrap.querySelector('.blk-dropdown'); if (!dd) return;
  dd.classList.add('open');
  setTimeout(() => {
    const close = e => {
      if (!wrap.contains(e.target)) { dd.classList.remove('open'); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}
function toggleBlockerDropdown(btn) {
  const wrap = btn.closest('.blk-add'); if (!wrap) return;
  const dd = wrap.querySelector('.blk-dropdown'); if (!dd) return;
  if (dd.classList.contains('open')) dd.classList.remove('open');
  else openBlockerDropdown(btn);
}

function addDraftTask(cardId) {
  const card = cardById(cardId); if (!card) return;
  card.draftTasks = card.draftTasks || defaultDraftTasks(card);
  const idx = card.draftTasks.push({ title: 'New task', desc: '', criteria: [], files: [] }) - 1;
  saveCards();
  App.repaintIssue();
  openDraftTask(cardId, idx);
}

function deleteDraftTask(cardId, idx) {
  const card = cardById(cardId); if (!card) return;
  card.draftTasks = card.draftTasks || [];
  card.draftTasks.splice(idx, 1);
  // Re-index blockedBy references: drop refs to the deleted task, shift higher refs down.
  card.draftTasks.forEach(t => {
    t.blockedBy = (t.blockedBy || [])
      .filter(b => b !== idx)
      .map(b => (b > idx ? b - 1 : b));
  });
  saveCards();
  closeInsights();
  App.repaintIssue();
}

/* ---- Human Review: one coherent eval plan for a feature, per-task for a task ---- */
/* Two-column split: the review content on the left, a "Request changes"
   sidepanel on the right (instead of the AI chat the PRD/Tasks tabs use).
   Each change request is a simple editable/deletable text block.
   When a feature's review tab is opened from ANOTHER column (i.e. after
   "Create tasks" sent it back to Define), the eval plan is an artifact —
   render it read-only, full width, no sidepanel. */
function reviewLayout(card, mainHtml) {
  // The review tab persists after "Implement changes" (task) or "Create tasks"
  // (feature) sends the card back to its work column. Viewed from there it's a
  // read-only artifact: full width, no "Request changes" sidepanel, with a
  // banner describing what's happening.
  const hasReview = card.steps.some(s => s.key === 'review');
  if (hasReview && card.col !== 'review') {
    let banner;
    if (card.kind === 'feature') {
      const round = card.reworkRound || 0;
      banner = round > 0
        ? `Rework in progress — edit the new tasks in the Tasks tab.`
        : `This evaluation is kept as a read-only artifact.`;
    } else {
      banner = `<span class="spin"></span><span>Implementing changes…</span>`;
    }
    return `<div class="review-readonly">
      <div class="review-readonly-banner">${banner}</div>
      ${mainHtml}
    </div>`;
  }
  return `<div class="prd-layout">
    <div class="prd-editor review-left">${mainHtml}</div>
    ${changeRequestsArea(card)}
  </div>`;
}

const TASK_QA_ITEMS = ['Streak of 1 renders correctly', 'DST day does not double-count', 'Timezone read from device'];

/* QA checklist whose state drives the Approve button. Persisted on the card
   as `card.qa` (booleans, aligned to the items array). */
function qaListHtml(card, items) {
  if (!Array.isArray(card.qa) || card.qa.length !== items.length) {
    card.qa = items.map((_, i) => !!(card.qa && card.qa[i]));
  }
  const ro = card.col !== 'review'; // read-only artifact when viewed from another column
  return `<ul class="qa">${items.map((label, i) =>
    `<li><input type="checkbox" ${card.qa[i] ? 'checked' : ''} ${ro ? 'disabled' : `onchange="toggleQa('${card.id}',${i})"`}> ${esc(label)}</li>`).join('')}</ul>`;
}
function qaComplete(card) {
  const qa = card.qa;
  return Array.isArray(qa) && qa.length > 0 && qa.every(Boolean);
}
function toggleQa(cardId, i) {
  const card = cardById(cardId); if (!card) return;
  card.qa = card.qa || [];
  card.qa[i] = !card.qa[i];
  saveCards();
  refreshReviewActions(cardId);
}

/* The review action button. With pending change requests a task becomes
   "Implement changes" (back to Implement for another pass) while a feature
   becomes "Create tasks" (back to the Tasks tab with one draft per request).
   With no change requests it's "Approve" — a secondary outline button until
   QA is complete, then a celebratory gradient button. */
function reviewActionsInner(card) {
  const changes = (card.changeRequests || []).length;
  if (changes > 0) {
    const label = card.kind === 'feature' ? 'Create tasks →' : 'Implement changes →';
    return `<button class="btn btn-primary issue-action-btn" onclick="implementChanges('${card.id}')">${label}</button>`;
  }
  if (qaComplete(card)) {
    return `<button class="btn btn-approve-grad issue-action-btn" onclick="approveCard('${card.id}')">Approve</button>`;
  }
  return `<button class="btn btn-outline issue-action-btn" onclick="confirmApprove('${card.id}')">Approve</button>`;
}
/* Swap just the action button without a full repaint so ticking a QA box
   doesn't tear down the focused checkbox. The button lives in the wizard
   footer inside a #review-actions wrapper. */
function refreshReviewActions(cardId) {
  const card = cardById(cardId); if (!card) return;
  const el = document.getElementById('review-actions');
  if (el) el.innerHTML = reviewActionsInner(card);
}

/* Human Review: start the card's dev server on its branch (single slot — see
   ADR 0009). Prototype mocks the host worktree + port; production uses
   POST /api/cards/:id/dev-server and returns a Tailscale-reachable URL. */
const DEV_SERVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
const DEV_OPEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;

function devServerForCard(cardId) {
  const ds = state.devServer;
  return ds && ds.cardId === cardId ? ds : null;
}

function reviewDevServerBtn(card) {
  const running = devServerForCard(card.id);
  if (running) {
    return `<button class="btn btn-primary issue-action-btn" type="button"
      onclick="openDevServer('${esc(card.id)}')" title="Open ${esc(running.url)}">
      ${DEV_OPEN_SVG} Open in Browser</button>`;
  }
  return `<button class="btn btn-outline issue-action-btn" type="button"
    onclick="startDevServer('${esc(card.id)}')" title="Start dev server on ${esc(card.branch || 'card branch')}">
    ${DEV_SERVER_SVG} Start Server</button>`;
}

function refreshReviewDevServer(cardId) {
  const card = cardById(cardId); if (!card) return;
  const el = document.getElementById('review-dev-server');
  if (el) el.innerHTML = reviewDevServerBtn(card);
}

function stopDevServer() {
  state.devServer = null;
}

function startDevServer(cardId) {
  const card = cardById(cardId); if (!card) return;
  const port = 5173;
  state.devServer = {
    cardId,
    port,
    url: `http://127.0.0.1:${port}`,
    branch: card.branch || `jeeves/card-${cardId}`,
  };
  refreshReviewDevServer(cardId);
}

function openDevServer(cardId) {
  const ds = devServerForCard(cardId);
  if (!ds) return;
  window.open(ds.url, '_blank', 'noopener,noreferrer');
}

/* =========================================================================
   HUMAN REVIEW · TASK EVALUATION PLAN
   In production this is a separate self-contained HTML doc rendered in an
   iframe. For the prototype we inline it so the sections are interactive.
   Each section is collapsible; open/closed state lives in state.epOpen so a
   repaint (e.g. after pushing an AI-review item into the Changes panel)
   preserves which sections are expanded.
   ========================================================================= */
const EP_ICONS = {
  critical: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 5h2v6h-2zm0 8h2v2h-2z"/></svg>`,
  warning:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info:     `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`
};
const EP_PLUS = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

/* Mocked eval-plan content for the streak-calc task. In production this is
   produced by the evaluator and shipped with the eval-plan HTML. */
const TASK_EVAL = {
  desc: "Adds the streak-calculation API endpoint. Reads activity events from the store, computes consecutive-day streaks honouring DST transitions and the device timezone, and returns the current streak and longest streak.",
  notices: [
    { type: 'critical', title: 'Deviation from plan', body: 'added a caching layer (streakCache) that the plan never specified' },
    { type: 'warning',  title: 'Test gap',            body: 'no test covering the DST spring-forward boundary day' },
    { type: 'info',     title: 'Refactor',            body: 'timezone helper extracted into tz.ts for reuse by the badge task' }
  ],
  uiChanges: true,
  shots: [
    { cap: 'Badge — before', sub: 'streak resets across DST' },
    { cap: 'Badge — after',  sub: 'streak survives DST' }
  ],
  /* Narrative diff: git diff reordered by architectural layer (not file
     path). Each group explains what changed and why; every file ref is a
     cursor://file/path:line link that opens in Cursor at the right line. */
  diff: [
    {
      layer: 'Business logic',
      why: 'Core streak math moved into streak.ts and now takes an explicit timezone so DST boundaries are honoured. A cache was added (not in the plan) to avoid recomputing on every badge render — this is the deviation flagged in Notifications.',
      files: [
        { path: 'src/streak.ts', line: 14 },
        { path: 'src/tz.ts', line: 1 }
      ],
      hunks: [
        { file: 'src/streak.ts', start: 14, lines: [
          { kind: 'ctx', text: " export function streak(events) {" },
          { kind: 'del', text: "-   const days = uniqueDays(events);" },
          { kind: 'del', text: "-   return countConsecutive(days);" },
          { kind: 'add', text: '+   const { tz } = deviceTz();' },
          { kind: 'add', text: '+   const days = uniqueDays(events, tz);' },
          { kind: 'add', text: '+   const result = countConsecutive(days);' },
          { kind: 'add', text: '+   streakCache.set(key(events), result); // not in plan' },
          { kind: 'add', text: '+   return result;' },
          { kind: 'ctx', text: ' }' }
        ] }
      ]
    },
    {
      layer: 'API',
      why: 'Thin controller over the calc core — no domain logic here, just request parsing and response shaping. The endpoint returns both the current and longest streak in one call.',
      files: [ { path: 'src/api/streak.ts', line: 12 } ],
      hunks: [
        { file: 'src/api/streak.ts', start: 12, lines: [
          { kind: 'ctx', text: " router.get('/streak', async ctx => {" },
          { kind: 'add', text: '+   const s = computeStreak(ctx.userId);' },
          { kind: 'add', text: '+   ctx.body = { current: s.current, longest: s.longest };' },
          { kind: 'ctx', text: ' });' }
        ] }
      ]
    },
    {
      layer: 'Tests',
      why: 'Added timezone and cache-hit coverage. The DST spring-forward case is skipped here — that is the test gap flagged in Notifications and queued as a follow-up.',
      files: [ { path: 'test/streak.test.ts', line: 40 } ],
      hunks: [
        { file: 'test/streak.test.ts', start: 40, lines: [
          { kind: 'add', text: '+ test("respects device timezone offset", () => {' },
          { kind: 'add', text: '+   expect(streak(events, { tz: "America/New_York" })).toEqual(3);' },
          { kind: 'add', text: '+ });' },
          { kind: 'add', text: '+ test.skip("DST spring-forward boundary", () => {});' }
        ] }
      ]
    }
  ],
  tests: {
    pass: 18, skip: 2, fail: 0,
    items: [
      { name: 'counts a single-day streak',          status: 'pass' },
      { name: 'bridges a gap shorter than 24h',      status: 'pass' },
      { name: 'respects device timezone offset',     status: 'pass' },
      { name: 'DST spring-forward boundary',         status: 'skip' },
      { name: 'cache hit returns same value',        status: 'pass' }
    ]
  },
  aiReview: [
    { text: 'Caching layer deviates from the plan — either document the decision or remove streakCache.' },
    { text: 'Add a DST spring-forward test case to close the test gap.' },
    { text: 'Consider exposing tz as an option instead of always reading the device default.' },
    { text: 'Longest-streak logic looks correct and well-named.' }
  ],
  meta: [
    ['Session duration', '4m 12s'],
    ['Tokens used',      '48,210  (31,004 in · 17,206 out)'],
    ['Model',            'claude-4.6-sonnet'],
    ['Branch',           'feat/streak-api'],
    ['Commit',           'a1f4c0e'],
    ['Files changed',    '4'],
    ['Lines of code',    '+126 / −18'],
    ['Cost',             '$0.21']
  ]
};

/* Mocked feature-level eval plan for the onboarding-revamp feature. This is
   the *acceptance gate* (stage 11, `/eval-acceptance`) — deliberately thinner
   than the per-task eval: no diff narrative and no thermo-nuclear review
   (those live on each child's eval plan, linked from the Tasks section).
   Instead it covers only what emerges once the slices are assembled. */
const FEATURE_EVAL = {
  desc: "Trims signup from 5 steps to 2 and adds a progress hint. All four child slices (signup-form collapse, progress hint, signup analytics, onboarding copy) are merged into feat/onboarding; this eval validates the feature as a whole against the PRD.",
  shots: [
    { cap: 'Signup — before', sub: '5 steps, 38% drop-off at step 3' },
    { cap: 'Signup — after',  sub: '2 steps + progress hint' },
    { cap: 'Completed state', sub: 'hint celebrates, routes to home' },
    { cap: 'Mobile signup',   sub: 'hint + email-only both fit one screen' }
  ],
  /* Feature-level only. Per-task flags live on the task cards in the Tasks
     section below — they are not duplicated here. */
  notices: [
    { type: 'warning',  title: 'Cross-slice inconsistency', body: 'progress-hint and copy tasks diverged on step wording — "Step 1 of 2" vs "1/2"' },
    { type: 'critical', title: 'Regression',                body: 'signup analytics fires twice on the final step — passed in the child eval, doubled after merge' },
    { type: 'info',     title: 'Non-goal check',            body: 'social sharing hook was not added (correct — deferred in PRD non-goals)' }
  ],
  tasks: [
    { id: 't-signup',    title: 'Signup form collapse',  flags: 1 },
    { id: 't-hint',      title: 'Progress hint component', flags: 0 },
    { id: 't-analytics', title: 'Signup analytics events', flags: 1 },
    { id: 't-copy',      title: 'Onboarding copy revision', flags: 0 }
  ],
  refactor: [
    'Pull the step-progress UI into a shared <Stepper> component — hint and form both roll their own.',
    'Two analytics event helpers (signup.ts + hint.ts) emit the same events — merge into one events module.',
    'onboardingStep() and signupStep() refer to the same thing — pick one name.'
  ],
  tests: {
    pass: 64, skip: 1, fail: 1,
    items: [
      { name: 'signup: submits with email-only',          status: 'pass' },
      { name: 'hint: renders on step 2',                  status: 'pass' },
      { name: 'analytics: fires once per step',           status: 'fail', regress: true },
      { name: 'e2e: signup → home redirect',              status: 'pass' },
      { name: 'e2e: logout → signup again shows hint',    status: 'pass' },
      { name: 'e2e: invalid email keeps hint on step 1',  status: 'pass' },
      { name: 'a11y: hint announced by screen reader',    status: 'skip' }
    ]
  },
  /* PRD acceptance criteria — in production auto-seeded from the PRD's own
     checkbox list authored during the Define stage, so the criteria written
     then are the exact same checkboxes checked here. */
  prdCriteria: [
    'Signup is 2 steps maximum',
    'Email-only — no phone field',
    'Progress hint visible on every step',
    'Drop-off analytics still fire'
  ],
  /* End-to-end journeys that span multiple slices. Behaviour-derived (written
     by /eval-acceptance after assembly), not spec-derived. */
  qaJourneys: [
    'New user → signup (email only) → lands on home with hint shown',
    'Existing user → logout → signup again → hint still appears',
    'Submit invalid email → error shown → hint stays on current step',
    'Complete signup → analytics fires once per step (not twice)'
  ],
  meta: [
    ['Slices merged',  '4'],
    ['Total duration', '26m 41s across 4 child runs + this eval'],
    ['Tokens used',    '198,420  (140,210 in · 58,210 out)'],
    ['Model',          'claude-4.6-sonnet'],
    ['Feature branch', 'feat/onboarding'],
    ['Base',           'main'],
    ['Commit',         'f3e2a81'],
    ['Files changed',  '17'],
    ['Lines of code',  '+612 / −284'],
    ['Total cost',     '$1.94']
  ]
};

function epOpen(id) {
  const o = state.epOpen || (state.epOpen = {});
  return o[id] !== false; /* default open */
}
function epToggle(id, btn) {
  const o = state.epOpen || (state.epOpen = {});
  o[id] = !epOpen(id);
  const sec = btn.closest('.ep-section');
  if (sec) sec.classList.toggle('closed', !epOpen(id));
}

function epSection(id, title, meta, bodyHtml) {
  const closed = epOpen(id) ? '' : ' closed';
  return `<section class="ep-section${closed}">
    <button class="ep-head" type="button" onclick="epToggle('${id}',this)" aria-expanded="${epOpen(id)}">
      <span class="ep-chev" aria-hidden="true"></span>
      <span class="ep-title">${title}</span>${meta ? `<span class="ep-meta muted">${meta}</span>` : ''}
    </button>
    <div class="ep-body">${bodyHtml}</div>
  </section>`;
}

function epNoticesHtml(notices) {
  const items = notices.map(n => `<li class="ep-notice ${n.type}">
      <span class="ep-n-icon">${EP_ICONS[n.type] || EP_ICONS.info}</span>
      <span class="ep-n-text"><b>${esc(n.title)}</b> — ${esc(n.body)}</span>
    </li>`).join('');
  return `<ul class="ep-notices">${items}</ul>`;
}

function epShotsHtml(shots) {
  if (!shots || !shots.length) return `<div class="muted" style="font-size:12.5px">No UI changes in this task.</div>`;
  return `<div class="ep-shots">${shots.map(s => `<figure class="ep-shot">
      <div class="ep-shot-img">screenshot</div>
      <figcaption class="ep-shot-cap"><b>${esc(s.cap)}</b><span class="muted">${esc(s.sub)}</span></figcaption>
    </figure>`).join('')}</div>`;
}

function epFileRef(f) {
  const uri = `cursor://file/${f.path}:${f.line}`;
  return `<a class="ep-file" href="${esc(uri)}" title="Open ${esc(uri)} in Cursor"
    onclick="event.preventDefault();epOpenCursor('${esc(uri)}')">${esc(f.path)}<span class="ep-file-line">:${f.line}</span></a>`;
}
/* In production this hands off to Cursor's URI handler; in the prototype we
   just acknowledge so the click is non-destructive. */
function epOpenCursor(uri) { alert('PROTOTYPE: open ' + uri + ' in Cursor'); }

function epHunkHtml(h) {
  const head = `<div class="row hunk">@@ ${esc(h.file)} @${h.start} @@</div>`;
  const rows = h.lines.map(r => `<div class="row ${r.kind}">${esc(r.text)}</div>`).join('');
  return `<div class="ep-diff">${head}${rows}</div>`;
}

function epDiffHtml(groups) {
  return groups.map(g => `<div class="ep-diff-group">
      <div class="ep-diff-layer">
        <span class="ep-diff-layer-name">${esc(g.layer)}</span>
        <span class="ep-diff-files">${g.files.map(epFileRef).join('')}</span>
      </div>
      <p class="ep-diff-why">${esc(g.why)}</p>
      ${g.hunks.map(epHunkHtml).join('')}
    </div>`).join('');
}

function epDiffCounts(groups) {
  let a = 0, d = 0;
  groups.forEach(g => g.hunks.forEach(h => h.lines.forEach(r => {
    if (r.kind === 'add') a++; else if (r.kind === 'del') d++;
  })));
  return `+${a} / −${d}`;
}

function epTestsHtml(t) {
  const summary = `<div class="ep-tests-summary">
      <span class="n ok"><b>${t.pass}</b> passed</span>
      <span class="n skip"><b>${t.skip}</b> skipped</span>
      <span class="n fail"><b>${t.fail}</b> failed</span>
    </div>`;
  const items = t.items.map(it => `<div class="ep-test${it.regress ? ' regress' : ''}">
      <span class="ep-chip ${it.status}">${it.status}</span>
      <span>${esc(it.name)}</span>
      ${it.regress ? '<span class="ep-chip regress">Regression</span>' : ''}
    </div>`).join('');
  return summary + `<div class="ep-test-list">${items}</div>`;
}

function epAiReviewHtml(items, ro) {
  const rows = items.map((it, i) => `<div class="ep-ai-item">
      <span class="txt">${esc(it.text)}</span>
      ${ro ? '' : `<button class="ep-ai-add" type="button" title="Add to Changes" aria-label="Add to Changes"
        onclick="addReviewToChanges(${i})">${EP_PLUS}</button>`}
    </div>`).join('');
  const hint = ro ? '' : `<div class="muted" style="font-size:11.5px;margin-top:7px">Use + to push a note into the Changes panel →</div>`;
  return `<div class="ep-ai">${rows}</div>${hint}`;
}

function epMetaHtml(meta) {
  const rows = meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  return `<dl class="ep-meta-grid">${rows}</dl>`;
}

/* AI-review + button → push the note into the card's change requests.
   We update only the Changes panel DOM (count badge, new block, footer
   button) instead of repainting the whole issue view, so the eval-plan
   panel's scroll position is preserved. Section open state is untouched. */
function pushChangeRequest(text) {
  const card = cardById(state.currentId); if (!card) return;
  const cr = { id: 'cr' + (++nextCardId), text };
  const list = ensureChangeRequests(card);
  list.push(cr);
  saveCards();

  const countEl = document.querySelector('.cr-count');
  if (countEl) countEl.textContent = String(list.length);

  const scroll = document.querySelector('.cr-scroll');
  if (scroll) {
    const empty = scroll.querySelector('.cr-empty');
    if (empty) empty.remove();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = crViewBlock(card, cr);
    const node = wrapper.firstElementChild;
    if (node) scroll.appendChild(node);
  }

  refreshReviewActions(card.id);
}
function addReviewToChanges(i) {
  const item = TASK_EVAL.aiReview[i];
  if (item) pushChangeRequest(item.text);
}
/* Refactor + button → same path as an AI-review note. No tag prefix: each
   change request becomes a plain task in the Tasks tab when "Create tasks" is
   clicked, and the originating section is irrelevant once it's a slice. */
function addRefactorToChanges(i) {
  const text = FEATURE_EVAL.refactor[i];
  if (text) pushChangeRequest(text);
}

function taskReviewArea(card) {
  const ev = TASK_EVAL;
  const ro = card.col !== 'review'; // read-only artifact when viewed from another column
  const round = card.reworkRound || 0;
  const reworkBadge = round > 0
    ? `<span class="rework-badge" title="Evaluation re-run after requested changes">Round ${round + 1}</span>`
    : '';
  const main = `<div class="ep">
    ${epSection('ep-sum',    'Summary', null,
      `${reworkBadge}<p class="ep-desc" style="margin-bottom:10px">${esc(ev.desc)}</p>` + epShotsHtml(ev.uiChanges ? ev.shots : null))}
    ${epSection('ep-notif',  'Notifications', `${ev.notices.length} flag${ev.notices.length === 1 ? '' : 's'}`,
      epNoticesHtml(ev.notices))}
    ${epSection('ep-diff',   'Code changes', epDiffCounts(ev.diff),
      epDiffHtml(ev.diff))}
    ${epSection('ep-tests',  'Tests', `${ev.tests.pass + ev.tests.skip} cases`,
      epTestsHtml(ev.tests))}
    ${epSection('ep-ai',     'AI review', `${ev.aiReview.length} notes`,
      epAiReviewHtml(ev.aiReview, ro))}
    ${epSection('ep-qa',     'QA checklist', null,
      qaListHtml(card, TASK_QA_ITEMS))}
    ${epSection('ep-meta',   'Metadata', null,
      epMetaHtml(ev.meta))}
  </div>`;
  return reviewLayout(card, main);
}
function featureTaskRowHtml(t, idx) {
  const flag = t.flags > 0
    ? `<span class="ep-flag-count">${t.flags} flag${t.flags === 1 ? '' : 's'}</span>`
    : `<span class="muted ep-task-noflag">no flags</span>`;
  return `<div class="card ep-task-row" onclick="openFeatureTask('${esc(t.id)}')" title="Open ${esc(t.title)} evaluation plan">
    <div class="card-pad">
      <div class="card-top">
        <span class="card-title">${idx + 1}. ${esc(t.title)}</span>
        ${flag}
      </div>
    </div>
  </div>`;
}
/* In production each child's eval plan is a self-contained HTML file committed
   on its branch; clicking opens that file. The prototype just acknowledges. */
function openFeatureTask(id) {
  alert("PROTOTYPE: opens task " + id + " evaluation plan (the self-contained HTML committed on the child's branch)");
}

function epRefactorHtml(items, ro) {
  const rows = items.map((it, i) => `<div class="ep-ai-item ep-refactor">
      <span class="txt">${esc(it)}</span>
      ${ro ? '' : `<button class="ep-ai-add" type="button" title="Add to Changes" aria-label="Add to Changes"
        onclick="addRefactorToChanges(${i})">${EP_PLUS}</button>`}
    </div>`).join('');
  return `<div class="ep-ai">${rows}</div>`;
}

/* Feature QA = two labelled sub-groups sharing one checkbox workflow and one
   Approve gate. PRD acceptance (spec-derived, top-down) + E2E journeys
   (behaviour-derived, bottom-up). Both back the single `card.qa` array so
   `qaComplete` / `toggleQa` / `refreshReviewActions` work unchanged. */
function featureQaHtml(card) {
  const prd = FEATURE_EVAL.prdCriteria;
  const journeys = FEATURE_EVAL.qaJourneys;
  const items = prd.concat(journeys);
  if (!Array.isArray(card.qa) || card.qa.length !== items.length) {
    card.qa = items.map((_, i) => !!(card.qa && card.qa[i]));
  }
  const ro = card.kind === 'feature' && card.col !== 'review'; // read-only artifact
  const group = (label, hint, list, offset) => `<div class="ep-qa-group">
      <div class="ep-qa-label">${label}<span class="muted"> ${hint}</span></div>
      <ul class="qa">${list.map((label2, j) =>
        `<li><input type="checkbox" ${card.qa[offset + j] ? 'checked' : ''} ${ro ? 'disabled' : `onchange="toggleQa('${card.id}',${offset + j})"`}> ${esc(label2)}</li>`).join('')}</ul>
    </div>`;
  return group('PRD acceptance criteria', '(spec-derived)', prd, 0)
       + group('End-to-end user journeys', '(behaviour-derived)', journeys, prd.length);
}

function featureReviewArea(card) {
  const ev = FEATURE_EVAL;
  const ro = card.col !== 'review'; // read-only artifact when viewed from another column
  const totalFlags = ev.tasks.reduce((s, t) => s + (t.flags || 0), 0);
  const taskRows = ev.tasks.map((t, i) => featureTaskRowHtml(t, i)).join('');
  const round = card.reworkRound || 0;
  const reworkBadge = round > 0
    ? `<span class="rework-badge" title="Evaluation re-run after rework">Round ${round + 1}</span>`
    : '';
  const main = `<div class="ep">
    ${epSection('ep-fsum',     'Summary', null,
      `${reworkBadge}<p class="ep-desc" style="margin:0 0 12px">${esc(ev.desc)}</p>` + epShotsHtml(ev.shots))}
    ${epSection('ep-fnotif',   'Notifications', `${ev.notices.length} feature-level`,
      epNoticesHtml(ev.notices))}
    ${epSection('ep-ftasks',   'Tasks', `${ev.tasks.length} merged · ${totalFlags} flags`,
      `<div class="ep-tasks">${taskRows}</div>`)}
    ${epSection('ep-frefactor','Refactor opportunities', `${ev.refactor.length} found`,
      epRefactorHtml(ev.refactor, ro))}
    ${epSection('ep-ftests',   'Tests — full regression', `${ev.tests.pass + ev.tests.skip + ev.tests.fail} cases`,
      epTestsHtml(ev.tests))}
    ${epSection('ep-fqa',      'QA — acceptance & journeys', null,
      featureQaHtml(card))}
    ${epSection('ep-fmeta',    'Metadata', null,
      epMetaHtml(ev.meta))}
  </div>`;
  return reviewLayout(card, main);
}

/* "Approve" clicked before QA is complete → confirm dialog. */
function confirmApprove(cardId) {
  if (document.querySelector('.insights-modal')) return;
  const overlay = document.createElement('div');
  overlay.className = 'insights-modal';
  overlay.innerHTML = `<div class="insights-card" role="dialog" aria-modal="true" aria-label="Confirm approve">
    <div class="insights-head"><b>QA not complete</b>
      <button class="x" type="button" onclick="closeInsights()" title="Close" aria-label="Close">✕</button></div>
    <div class="ins-body"><p style="font-size:13px;margin:6px 0;line-height:1.5">You haven't finished the QA checklist yet. Approve and merge anyway?</p></div>
    <div class="ins-foot" style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-outline btn-sm" onclick="closeInsights()">Cancel</button>
      <button class="btn btn-primary btn-sm" onclick="approveCard('${cardId}')">Approve anyway</button>
    </div>
  </div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeInsights(); });
  document.body.appendChild(overlay);
}

/* Approve → merge. task-child has no Finalize stage, so it leaves the board;
   standalone tasks and features advance to Finalize. */
function approveCard(cardId) {
  closeInsights();
  stopDevServer();
  const card = cardById(cardId); if (!card) return;
  if (card.kind === 'task-child') {
    const idx = CARDS.findIndex(c => c.id === cardId);
    if (idx !== -1) CARDS.splice(idx, 1);
    saveCards();
    App.afterDelete();
    return;
  }
  card.col = 'finalize';
  card.evalReady = false;
  card.changeRequests = [];
  card.steps = mk(card.kind, 'finalize', { document: 'pending', deploy: 'pending' });
  state.step = dialogStartIndex(card);
  state.editingCR = null;
  saveCards();
  App.repaintIssue();
}

/* "Implement changes" (task) / "Create tasks" (feature) → act on the requested
   changes. A task goes back to the Implement column for another pass. A feature
   does NOT re-implement in place — instead it returns to the Define column's
   Tasks tab with one new draft task per change request, so the human/AI can
   shape the rework slices before they ship. The Human Review tab persists as a
   read-only artifact (review step flips to 'done' rather than being dropped),
   the prior draft tasks are archived as read-only rounds, and the change
   requests are consumed into drafts (the sidebar empties). */
function implementChanges(cardId) {
  const card = cardById(cardId); if (!card) return;
  stopDevServer();
  card.evalReady = false;
  if (card.kind === 'task-child' || card.kind === 'task-standalone') {
    // Record the requested changes on the card (shown in the Info tab under
    // "Changes added later") before consuming them.
    const reqs = (card.changeRequests || []).map(cr => cr.text).filter(Boolean);
    if (reqs.length) {
      card.addedChanges = (card.addedChanges || []).concat(reqs);
    }
    card.changeRequests = [];
    card.qa = [];            // reset acceptance gate — re-checked on re-review
    card.reworkRound = (card.reworkRound || 0) + 1;
    card.col = 'implement';
    // Mutate steps in place so the Human Review tab PERSISTS as a read-only
    // artifact (a from-scratch mk would drop it). plan done, impl queued for
    // another pass, airev pending, review → done artifact.
    const planStep = card.steps.find(s => s.key === 'plan');
    if (planStep) planStep.status = 'done';
    const implStep = card.steps.find(s => s.key === 'impl');
    if (implStep) implStep.status = 'queued';
    const airevStep = card.steps.find(s => s.key === 'airev');
    if (airevStep) airevStep.status = 'pending';
    const reviewStep = card.steps.find(s => s.key === 'review');
    if (reviewStep) reviewStep.status = 'done';
    // Stay on the Human Review tab (read-only artifact) rather than jumping to
    // the AI Review tab, so the user sees the "Implementing changes…" banner.
    state.step = card.steps.findIndex(s => s.key === 'review');
  } else {
    // Archive the current draft tasks as a completed round (if any), then seed
    // the editable list from the change requests — one task per request.
    const priorDrafts = card.draftTasks && card.draftTasks.length ? card.draftTasks : null;
    if (priorDrafts) {
      card.archivedTasks = card.archivedTasks || [];
      const round = (card.reworkRound || 0) + 1; // the round just completed
      card.archivedTasks.push({ round, tasks: priorDrafts.map(d => ({ ...d })) });
    }
    card.reworkRound = (card.reworkRound || 0) + 1;
    card.draftTasks = (card.changeRequests || []).map(cr => ({
      title: cr.text || 'Rework task', desc: '', criteria: [], files: []
    }));
    card.changeRequests = [];
    card.qa = [];            // reset acceptance gate — re-checked on re-review
    card.implProgress = null; // stale round-1 progress; implementTasks re-sets it
    card.col = 'shape';
    // Mutate steps in place so the Human Review tab PERSISTS (a from-scratch
    // mk('feature','shape',…) would drop it). tasks → editable, review → done
    // artifact, grill/prd stay done.
    const tasksStep = card.steps.find(s => s.key === 'tasks');
    if (tasksStep) tasksStep.status = 'needs-user';
    const reviewStep = card.steps.find(s => s.key === 'review');
    if (reviewStep) reviewStep.status = 'done';
    // Land on the Tasks tab so the user can edit the rework drafts.
    state.step = dialogStartIndex(card);
  }
  state.editingCR = null;
  saveCards();
  App.repaintIssue();
}

/* ---- "Request changes" sidepanel: a list of simple text blocks. ---- */
const crEditSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const crTrashSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

function ensureChangeRequests(card) {
  card.changeRequests = card.changeRequests || [];
  return card.changeRequests;
}

function crViewBlock(card, cr) {
  return `<div class="cr-block">
    <div class="cr-text">${cr.text ? esc(cr.text) : '<em>Empty change</em>'}</div>
    <div class="cr-actions">
      <button class="cr-ic" type="button" title="Edit" aria-label="Edit" onclick="editChangeRequest('${cr.id}')">${crEditSvg}</button>
      <button class="cr-ic cr-del" type="button" title="Delete" aria-label="Delete" onclick="deleteChangeRequest('${cr.id}')">${crTrashSvg}</button>
    </div>
  </div>`;
}
function crEditBlock(card, cr) {
  return `<div class="cr-block editing">
    <textarea class="cr-ed" id="cr-ed-${esc(cr.id)}" rows="2" placeholder="Describe the change…"
      onkeydown="crEditKey(event,'${esc(cr.id)}')">${esc(cr.text || '')}</textarea>
    <div class="cr-edit-foot">
      <button class="btn btn-outline btn-sm" type="button" onclick="cancelEditChangeRequest()">Cancel</button>
      <button class="btn btn-primary btn-sm" type="button" onclick="saveChangeRequest('${esc(cr.id)}')">Save</button>
    </div>
  </div>`;
}
function crNewBlock() {
  return `<div class="cr-block editing">
    <textarea class="cr-ed" id="cr-ed-new" rows="2" placeholder="Describe the change…"
      onkeydown="crEditKey(event,'new')"></textarea>
    <div class="cr-edit-foot">
      <button class="btn btn-outline btn-sm" type="button" onclick="cancelEditChangeRequest()">Cancel</button>
      <button class="btn btn-primary btn-sm" type="button" onclick="addChangeRequest()">Add</button>
    </div>
  </div>`;
}

function changeRequestsArea(card) {
  const list = ensureChangeRequests(card);
  const editing = state.editingCR; // null | 'new' | { id }
  const blocks = list.map(cr =>
    editing && typeof editing === 'object' && editing.id === cr.id ? crEditBlock(card, cr) : crViewBlock(card, cr)
  ).join('');
  const addBlock = editing === 'new' ? crNewBlock() : '';
  const empty = !list.length && editing !== 'new'
    ? `<div class="cr-empty">No change requests yet. Add one below.</div>` : '';
  const addBtn = editing !== 'new'
    ? `<button class="btn btn-outline btn-sm cr-add-btn" type="button" onclick="startNewChangeRequest()">+ Add change</button>` : '';
  return `<aside class="prd-side cr-side">
    <div class="cr-head"><b>Request changes</b><span class="cr-count">${list.length}</span></div>
    <div class="cr-scroll">${empty}${blocks}${addBlock}</div>
    <div class="cr-foot">${addBtn}</div>
  </aside>`;
}

/* Change-request mutations. Editing state lives in `state.editingCR` so a
   repaint only tears down the block being edited, not the whole panel. */
function startNewChangeRequest() {
  state.editingCR = 'new';
  App.repaintIssue();
  setTimeout(() => document.getElementById('cr-ed-new')?.focus(), 30);
}
function addChangeRequest() {
  const card = cardById(state.currentId); if (!card) return;
  const v = (document.getElementById('cr-ed-new')?.value || '').trim();
  if (!v) { cancelEditChangeRequest(); return; }
  ensureChangeRequests(card).push({ id: 'cr' + (++nextCardId), text: v });
  state.editingCR = null;
  saveCards();
  App.repaintIssue();
}
function editChangeRequest(id) {
  state.editingCR = { id };
  App.repaintIssue();
  setTimeout(() => {
    const el = document.getElementById('cr-ed-' + id);
    if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
  }, 30);
}
function saveChangeRequest(id) {
  const card = cardById(state.currentId); if (!card) return;
  const v = document.getElementById('cr-ed-' + id)?.value ?? '';
  const cr = (card.changeRequests || []).find(c => c.id === id);
  if (cr) { cr.text = v; saveCards(); }
  state.editingCR = null;
  App.repaintIssue();
}
function deleteChangeRequest(id) {
  const card = cardById(state.currentId); if (!card) return;
  card.changeRequests = (card.changeRequests || []).filter(c => c.id !== id);
  if (state.editingCR && state.editingCR.id === id) state.editingCR = null;
  saveCards();
  App.repaintIssue();
}
function cancelEditChangeRequest() {
  state.editingCR = null;
  App.repaintIssue();
}
/* Ctrl/Cmd+Enter saves the block being edited; Esc cancels. */
function crEditKey(e, id) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (id === 'new') addChangeRequest(); else saveChangeRequest(id);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelEditChangeRequest();
  }
}

/* =========================================================================
   ISSUE VIEW  — header tabs / body / footer (rendered by issue.html)
   ========================================================================= */
/* Tabs that haven't been unlocked yet are hidden from the tab row.
   Info is always visible; PRD and Tasks only appear once the prior step
   hands off to them (their status flips from 'pending' to 'needs-user'). */
function isTabVisible(step) {
  if (step.kind === 'info') return true;
  if ((step.key === 'prd' || step.key === 'tasks') && step.status === 'pending') return false;
  return true;
}

function tabHtml(s, idx, cur) {
  const cls = ['wz-tab',
    idx === cur ? 'active' : '',
    s.kind === 'info' ? 'info' : '',
    s.status === 'done' ? 'done' : '',
    s.status === 'queued' ? 'queued' : '',
    s.status === 'ai-working' ? 'ai' : '',
    s.status === 'needs-user' ? 'user' : ''].filter(Boolean).join(' ');
  return `<div class="${cls}" onclick="gotoStep(${idx})">${s.label}</div>`;
}

function infoBody(card) {
  const added = (card.addedChanges && card.addedChanges.length)
    ? `<div class="issue-field" style="margin-top:16px">
        <label class="sec-label">Changes added later</label>
        <ul class="added-changes">${card.addedChanges.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>`
    : '';
  return `
    <div class="issue-field">
      <label class="sec-label" for="issue-title">Title</label>
      <input class="issue-input" id="issue-title" type="text"
             value="${esc(card.title)}" placeholder="Issue title…"
             autocomplete="off" oninput="autoSaveInfo()">
    </div>
    <div class="issue-field" style="margin-top:16px">
      <label class="sec-label" for="issue-desc">Description</label>
      <textarea class="ed" id="issue-desc"
        placeholder="Describe the issue…"
        oninput="autoSaveInfo()"
      >${esc(card.desc || '')}</textarea>
    </div>${added}`;
}

function dialogFooter(card, i, step) {
  const del = `<button class="btn btn-delete btn-sm" onclick="deleteCard('${card.id}')">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
    Delete</button>`;
  // Info tab of a backlog card → offer the stage-advance actions.
  if (step.kind === 'info' && card.col === 'backlog') {
    return `<div class="wizard-foot">${del}<div style="flex:1"></div>
      <button class="btn btn-outline issue-action-btn" onclick="advance('implement')">Implement now →</button>
      <button class="btn btn-primary issue-action-btn" onclick="advance('define')">Grill me →</button></div>`;
  }
  // Grill tab → hand off to the PRD step.
  if (step.key === 'grill' && step.status !== 'done') {
    return `<div class="wizard-foot">${del}<div style="flex:1"></div>
      <button class="btn btn-primary issue-action-btn" onclick="createPrd()">Create PRD →</button></div>`;
  }
  // PRD tab → hand off to the Tasks step.
  if (step.key === 'prd' && step.status !== 'done') {
    return `<div class="wizard-foot">${del}<div style="flex:1"></div>
      <button class="btn btn-primary issue-action-btn" onclick="createTasks()">Create Tasks →</button></div>`;
  }
  // Tasks tab (awaiting confirm) → kick off implementation of the slices.
  if (step.key === 'tasks' && step.status === 'needs-user') {
    return `<div class="wizard-foot">${del}<div style="flex:1"></div>
      <button class="btn btn-primary issue-action-btn" onclick="implementTasks('${card.id}')">Implement →</button></div>`;
  }
  // Tasks tab (implementing) → simulate the AI finishing and advance to review.
  if (step.key === 'tasks' && step.status === 'ai-working') {
    return `<div class="wizard-foot">${del}<div style="flex:1"></div>
      <button class="btn btn-outline issue-action-btn" onclick="completeTasks('${card.id}')">Simulate AI finished → review</button></div>`;
  }
  // Human Review tab → Approve / Create tasks / Implement changes (driven by
  // the sidebar + QA). When the tab is opened as a read-only artifact from
  // another column (after "Implement changes"/"Create tasks" sent the card
  // back to its work column), show no action footer — just the delete control.
  // Checked before the implement-column branch so the artifact view stays read-only.
  if (step.key === 'review') {
    if (card.col !== 'review') {
      return `<div class="wizard-foot">${del}</div>`;
    }
    return `<div class="wizard-foot">${del}<div style="flex:1"></div>
      <span id="review-dev-server">${reviewDevServerBtn(card)}</span>
      <span id="review-actions">${reviewActionsInner(card)}</span></div>`;
  }
  // A task card (child or standalone) mid-Implement → simulate the AI finishing
  // its plan/impl/AI-review and hand it off to Human Review.
  if (card.col === 'implement' && (card.kind === 'task-child' || card.kind === 'task-standalone')) {
    return `<div class="wizard-foot">${del}<div style="flex:1"></div>
      <button class="btn btn-outline issue-action-btn" onclick="completeChildTask('${card.id}')">Simulate AI finished → review</button></div>`;
  }
  return `<div class="wizard-foot">${del}</div>`;
}

/* =========================================================================
   BOARD
   ========================================================================= */
/* Mobile shows one column at a time as a list; the bottom nav switches it.
   Desktop ignores `state.mobileCol` and renders every column side by side. */
function mobileActiveCol() {
  if (!state.mobileCol || !COLUMNS.some(c => c.id === state.mobileCol)) state.mobileCol = 'backlog';
  return state.mobileCol;
}
function selectMobileCol(id) {
  state.mobileCol = id;
  if (typeof render === 'function') render();
}

function renderBoard() {
  const active = mobileActiveCol();
  const cols = COLUMNS.map(col => {
    const body = (col.id === 'implement' || col.id === 'review') ? groupedColBody(col.id) : simpleColBody(col.id);
    return `<div class="col${col.id === active ? ' mobile-active' : ''}" data-col="${col.id}">
      <div class="col-wrap">
        <div class="col-head">
          <span class="name">${col.name}</span>
          ${col.id === 'backlog' ? `<button class="col-head-btn" onclick="addIssue()" title="Add to backlog">+</button>` : ''}
        </div>
        <div class="col-body">${body}</div>
      </div>
    </div>`;
  }).join('');
  const nav = COLUMNS.map(col => {
    const count = cardsInCol(col.id).length;
    return `<button class="mnav-btn${col.id === active ? ' active' : ''}" type="button"
      onclick="selectMobileCol('${col.id}')" title="${esc(col.name)}" aria-label="${esc(col.name)}">
      <span class="mnav-label">${esc(col.short)}</span>
      <span class="mnav-count">${count}</span>
    </button>`;
  }).join('');
  return `<div class="topbar">
    <div class="brand"><span class="j">J</span>JEEVES board</div>
    <div class="project-picker">
      <select class="picker-select" aria-label="Project">
        <option selected>nxtfit</option>
        <option>jeeves</option>
      </select>
    </div>
    <div class="spacer"></div>
    <button class="btn btn-outline btn-sm" onclick="resetCards();render()" title="Restore demo data">Reset</button>
    <button class="btn btn-primary" onclick="addIssue()">+ Add issue</button>
  </div>
  <div class="scroll"><div class="board">${cols}</div></div>
  <nav class="mnav" aria-label="Columns">${nav}</nav>`;
}

function simpleColBody(colId) {
  const cards = cardsInCol(colId);
  return cards.length ? cards.map(renderCard).join('') : `<div class="col-empty">No cards</div>`;
}

/* Columns that show feature-grouped tasks: child tasks are gathered under a
   subtle dashed group headed by their parent feature's name (with a stable
   accent colour), standalone cards render flat with no accent. Used by both
   Implement (child tasks mid-flight) and Human Review (child tasks awaiting
   your call), so a feature's tasks stay visually traceable across columns. */
function groupedColBody(colId) {
  const cards = cardsInCol(colId);
  if (!cards.length) return `<div class="col-empty">No cards</div>`;
  const standalone = cards.filter(c => !c.parent);
  const childGroups = {};
  cards.filter(c => c.parent).forEach(c => { (childGroups[c.parent] = childGroups[c.parent] || []).push(c); });
  let html = '';
  for (const parentId of Object.keys(childGroups)) {
    const parent = cardById(parentId);
    const accent = accentFor(parentId);
    const kids = childGroups[parentId];
    html += `<div class="task-group">
      <div class="task-group-head"><span style="flex:1">${esc(parent?.title || 'feature')}</span>${flagSvg(11, 'var(--muted-foreground)')}</div>
      ${kids.map(c => `<div style="--accent:${accent}">${renderCard(c)}</div>`).join('')}
    </div>`;
  }
  standalone.forEach(c => { html += renderCard(c); });
  return html;
}

function renderCard(card) {
  const a = activeStep(card);
  let cur;
  if (a && a.key === 'tasks' && a.status === 'ai-working' && card.implProgress) {
    cur = `<div class="seg-current"><span class="spin"></span> <span>Implementing Task ${card.implProgress.cur} of ${card.implProgress.total}</span></div>`;
  } else if (a) {
    cur = `<div class="seg-current">${stepIcon(a.status)} <span>${a.label}</span></div>`;
  } else {
    cur = `<div class="card-desc">${esc(card.desc) || '<span style="color:var(--muted-foreground);font-style:italic">No description</span>'}</div>`;
  }
  // Child tasks inside a grouped column (Implement, Human Review) are already
  // shown under their parent feature's header, so no chip is needed there.
  // Elsewhere they get a subtle parent chip to stay traceable to their feature.
  const groupedCols = ['implement', 'review'];
  const parentChip = (card.kind === 'task-child' && card.parent && !groupedCols.includes(card.col))
    ? `<div class="parent-chip"><span class="dot" style="background:${accentFor(card.parent)}"></span>part of ${esc(cardById(card.parent)?.title || 'feature')}</div>`
    : '';
  const flag = card.kind === 'feature' ? flagSvg(15, 'var(--foreground)') : '';
  const num = taskNumber(card);
  const titleText = esc(card.title) || '<em style="color:var(--muted-foreground)">Untitled</em>';
  const title = num ? `${num}. ${titleText}` : titleText;
  return `<div class="card ${needsUser(card) ? 'needs-user' : ''}" onclick="openCard('${card.id}')">
    <div class="card-pad">
      <div class="card-top">
        <span class="card-title">${title}</span>
        ${flag}
      </div>
      ${segBar(card)}${cur}${parentChip}
    </div></div>`;
}

/* =========================================================================
   PAGE HOOKS  — each page registers its navigation/repaint behaviour.
   ========================================================================= */
const App = {
  openCard: id => { },  // board: navigate to issue page; issue: in-page hash change
  repaintIssue: () => { },  // issue page re-render
  afterDelete: () => { },  // issue page: go back to board
};

/* Shared view state (issue page drives it; board doesn't need it). */
const state = { currentId: null, step: 0, editingCR: null, devServer: null };

function openCard(id) { App.openCard(id); }

function gotoStep(i) {
  const card = cardById(state.currentId);
  if (!card) return;
  state.step = Math.max(0, Math.min(card.steps.length - 1, i));
  App.repaintIssue();
}

/* ---- Grill chat composer helpers ---- */
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}
function composerKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const el = e.target;
    if (!el.value.trim()) return;
    el.value = '';
    autoGrow(el);
    // prototype: no real send wiring — message would append to the chat here
  }
}
function attachFile(btn) {
  // prototype: open a hidden file picker and stub the attachment
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => {
    const names = Array.from(input.files || []).map(f => f.name);
    if (names.length && btn) btn.title = 'Attach files · ' + names.join(', ');
  };
  input.click();
}

function autoSaveInfo() {
  const card = cardById(state.currentId);
  if (!card) return;
  card.title = document.getElementById('issue-title')?.value || '';
  card.desc = document.getElementById('issue-desc')?.value || '';
  saveCards();
  const t = document.getElementById('dlg-title');
  if (t) t.textContent = card.title || 'Untitled';
  // NOTE: no full repaint — that would tear down the focused input mid-keystroke.
  // The board reads from localStorage on return, so it stays in sync.
}

/* Move a backlog card forward into a stage and grow its step tabs.
   "define" creates a feature; "implement" creates a standalone task. */
function advance(action) {
  const card = cardById(state.currentId);
  if (!card) return;
  if (!card.title.trim()) card.title = 'Untitled issue';
  if (action === 'define') {
    card.kind = 'feature';
    card.col = 'shape';
    card.steps = mk('feature', 'shape', { grill: 'needs-user', prd: 'pending', tasks: 'pending' });
  } else if (action === 'implement') {
    card.kind = 'task-standalone';
    card.col = 'implement';
    card.steps = mk('task-standalone', 'implement', { plan: 'queued', impl: 'pending', airev: 'pending' });
  }
  card.steps.find(s => s.kind === 'info').status = 'done';
  state.step = dialogStartIndex(card);
  saveCards();
  App.repaintIssue();
}

/* Grill → PRD hand-off: mark the grill step done and jump to the PRD tab. */
function createPrd() {
  const card = cardById(state.currentId);
  if (!card) return;
  const grill = card.steps.find(s => s.key === 'grill');
  if (grill) grill.status = 'done';
  const prd = card.steps.find(s => s.key === 'prd');
  if (prd && prd.status === 'pending') prd.status = 'needs-user';
  const prdIdx = card.steps.findIndex(s => s.key === 'prd');
  if (prdIdx >= 0) state.step = prdIdx;
  saveCards();
  App.repaintIssue();
}

/* Persist manual PRD edits without a full repaint (keeps the textarea focused). */
function autoSavePrd() {
  const card = cardById(state.currentId);
  if (!card) return;
  card.prd = document.getElementById('prd-doc')?.value || '';
  saveCards();
}

/* PRD → Tasks hand-off: mark the PRD step done, prime Tasks for user confirm, jump to it. */
function createTasks() {
  const card = cardById(state.currentId);
  if (!card) return;
  autoSavePrd();
  const prd = card.steps.find(s => s.key === 'prd');
  if (prd) prd.status = 'done';
  const tasks = card.steps.find(s => s.key === 'tasks');
  if (tasks && tasks.status === 'pending') tasks.status = 'needs-user';
  if (!card.draftTasks) card.draftTasks = defaultDraftTasks(card);
  const tasksIdx = card.steps.findIndex(s => s.key === 'tasks');
  if (tasksIdx >= 0) state.step = tasksIdx;
  saveCards();
  App.repaintIssue();
}

/* Feature's "Implement" hand-off: spawn child task cards and turn Tasks orange.
   Rework rounds get a /rework-N-M branch suffix so they don't collide with the
   original /card-M branch names. */
function implementTasks(featureId) {
  const card = cardById(featureId);
  if (!card) return;
  const drafts = card.draftTasks || defaultDraftTasks(card);
  const round = card.reworkRound || 0;
  drafts.forEach((d, idx) => {
    const id = 'tc' + (++nextCardId);
    const branchSuffix = round > 0 ? `rework-${round}-${idx + 1}` : `card-${idx + 1}`;
    CARDS.push({
      id, col: 'implement', kind: 'task-child', parent: card.id, title: d.title, desc: d.desc,
      branch: `${card.branch || 'feat/new'}/${branchSuffix}`,
      steps: mk('task-child', 'implement', { plan: 'queued', impl: 'pending', airev: 'pending' })
    });
  });
  card.implProgress = { cur: 1, total: drafts.length };
  card.steps.find(s => s.key === 'tasks').status = 'ai-working';
  state.step = dialogStartIndex(card);
  saveCards();
  App.repaintIssue();
}

/* Simulate all children merged → Tasks done → feature auto-advances to review.
   On a rework re-review the acceptance gate resets (qa emptied) so the human
   re-checks QA against the freshly merged state; changeRequests are already
   empty (consumed into tasks when "Create tasks" was clicked). */
function completeTasks(featureId) {
  const card = cardById(featureId);
  if (!card) return;
  childrenOf(card).forEach(c => { const i = CARDS.indexOf(c); if (i !== -1) CARDS.splice(i, 1); });
  card.childCount = card.implProgress?.total || childrenOf(card).length;
  card.col = 'review';
  card.evalReady = true;
  card.flags = card.flags || 2;
  card.changeRequests = [];
  card.steps = mk('feature', 'review', { grill: 'done', prd: 'done', tasks: 'done', review: 'needs-user' });
  card.qa = []; // reset: featureQaHtml re-initialises to all-unchecked on render
  state.step = dialogStartIndex(card);
  saveCards();
  App.repaintIssue();
}

/* Simulate a single child/standalone task finishing implementation and moving
   into Human Review. Keeps the parent feature's implProgress roughly in sync. */
function completeChildTask(taskId) {
  const card = cardById(taskId);
  if (!card) return;
  const kind = card.kind;
  card.col = 'review';
  card.evalReady = true;
  card.flags = card.flags || 1;
  card.changeRequests = [];
  card.steps = mk(kind, 'review', { review: 'needs-user' });
  card.qa = []; // reset: qaListHtml re-initialises to all-unchecked on render
  if (card.parent) {
    const parent = cardById(card.parent);
    if (parent && parent.implProgress) {
      const remaining = childrenOf(parent).filter(c => c.col === 'implement').length;
      parent.implProgress.cur = Math.max(parent.implProgress.cur, parent.implProgress.total - remaining);
    }
  }
  state.step = dialogStartIndex(card);
  saveCards();
  App.repaintIssue();
}

function addIssue() {
  const id = 'c' + (++nextCardId);
  CARDS.push({ id, col: 'backlog', kind: null, title: '', desc: '', branch: null, steps: mk(null, 'backlog') });
  saveCards();
  App.openCard(id);
}

function deleteCard(id) {
  if (!confirm('Delete this issue?')) return;
  const idx = CARDS.findIndex(c => c.id === id);
  if (idx !== -1) CARDS.splice(idx, 1);
  saveCards();
  App.afterDelete();
}
