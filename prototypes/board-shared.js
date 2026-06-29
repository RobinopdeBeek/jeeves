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
    {
      id: 'fr1', col: 'review', kind: 'feature', title: 'Onboarding revamp', desc: 'Trim signup to 2 steps, add progress hint.',
      branch: 'feat/onboarding', flags: 3, evalReady: true, childCount: 4,
      steps: mk('feature', 'review', { grill: 'done', prd: 'done', tasks: 'done', review: 'needs-user' }),
      qa: [true, false, false],
      changeRequests: [
        { id: 'cr-fr1a', text: 'Step 2 still asks for phone — PRD said email-only signup.' },
      ],
    },

    // ---- Feature in Finalize ----
    {
      id: 'f1', col: 'finalize', kind: 'feature', title: 'Profile redesign', desc: 'New profile layout with stat cards.',
      branch: 'feat/profile', steps: mk('feature', 'finalize', { refactor: 'done', document: 'ai-working', deploy: 'queued' })
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
  { id: 'backlog', name: 'Backlog', sub: 'Captured ideas, not started' },
  { id: 'shape', name: 'Define Feature', sub: 'Features: Grill → PRD → Tasks' },
  { id: 'implement', name: 'Implement Task', sub: 'Tasks: Plan → Implement → AI Review' },
  { id: 'review', name: 'Human Review', sub: 'Your call before merge' },
  { id: 'finalize', name: 'Finalize', sub: 'Refactor → Document → Deploy' },
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
  finalize: [['refactor', 'Refactor', 'ai'], ['document', 'Document', 'ai'], ['deploy', 'Deploy', 'ai']],
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
    <span>tokens 184k</span><span>cost $2.41</span><span>composer-2</span></div>`;
}

/* ---- Insights modal (replaces the old inline ov-meta line) ---- */
function insightsHtml(card) {
  const done = card.steps.filter(s => s.status === 'done').length;
  const total = card.steps.length;
  const row = (label, val) => `<div class="ins-row"><span class="ins-k">${label}</span><span class="ins-v">${val}</span></div>`;
  return `<div class="ins-body">
    ${row('Branch', card.branch ? `⎇ ${esc(card.branch)}` : '<span class="muted">no branch yet</span>')}
    ${row('Model', 'composer-2')}
    ${row('Tokens', '184k')}
    ${row('Cost', '$2.41')}
    ${row('Progress', `${done} / ${total} steps done`)}
    ${row('Kind', esc(card.kind || '—'))}
  </div>
  <div class="ins-foot muted">More insights (tokens by step, run history, diffs) will appear here.</div>`;
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
      <div class="ok">[12:04:03] ✓ cursor("composer-2") session started</div>
      <div>[12:04:31] writing domain/streak.ts</div>
      <div class="warn">[12:05:02] ⚠ adding date-fns-tz for DST handling</div>
      <div>[12:05:58] running vitest …</div>
      <div><span class="spin" style="display:inline-block;vertical-align:-2px"></span> running…</div></div>`;
  if (T === 'airev') return `<div class="panel findings">
      <div class="f"><span class="badge badge-destructive">Major</span><span>No test for DST transition day — streak may double-count.</span></div>
      <div class="f"><span class="badge badge-secondary">Minor</span><span>computeStreak() reads Date.now() directly — inject a clock.</span></div>
      <div class="f"><span class="badge badge-outline">Suggestion</span><span>Memoise per user; recompute on new log only.</span></div></div>`;
  if (T === 'review') return card.kind === 'feature' ? featureReviewArea(card) : taskReviewArea(card);
  if (T === 'refactor') return `<div class="panel findings">
      <div class="f"><span class="badge badge-secondary">Opportunity</span><span>Extract <code>streak</code> + <code>badge</code> into a shared <code>gamification</code> module.</span></div>
      <div class="f"><span class="badge badge-secondary">Opportunity</span><span>Two timezone helpers diverged — consolidate.</span></div></div>`;
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

function tasksLeft(card, step) {
  if (step.status === 'needs-user') {
    const drafts = card.draftTasks || (card.draftTasks = defaultDraftTasks(card), card.draftTasks);
    const list = drafts.map((d, idx) => draftCardHtml(card, d, idx)).join('');
    return `<div class="tasks-list">${list}</div>`;
  }
  if (step.status === 'ai-working') {
    const kids = childrenOf(card);
    // Board-style cards; tasks that need your eye (human review) float to top.
    const sorted = [...kids].sort((a, b) => Number(needsUser(b)) - Number(needsUser(a)));
    return `<div class="tasks-list">${sorted.map(renderCard).join('')}</div>`;
  }
  const n = card.childCount || childrenOf(card).length || 'all';
  return `<div class="panel doc"><h4>Tasks complete</h4><p>${n} task${n === 1 ? '' : 's'} implemented and merged. Ready for your review of the whole feature.</p></div>`;
}

function tasksArea(card) {
  const step = card.steps.find(s => s.key === 'tasks');
  const count = (card.draftTasks || []).length;
  const fab = step.status === 'needs-user'
    ? `<button class="btn btn-outline fab" type="button" onclick="addDraftTask('${card.id}')" title="Add task">+ Add task</button>`
    : '';
  // During implementation (ai-working) the sidepanel isn't useful — the work
  // is happening on the child task cards, not in this chat. Hide it so the
  // task list gets the full width.
  const side = step.status === 'ai-working' ? '' : `<aside class="prd-side">
      <div class="chat">
        <div class="bub ai">I've broken the feature into ${count || 'a few'} end-to-end slices. Click any task to inspect or edit it.</div>
        <div class="bub me">Make the API slice cover the DST edge case too.</div>
        <div class="bub ai">Done — added a criterion and a test file to that slice.</div>
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
    desc:  document.getElementById('draft-desc')?.value || '',
    criteria: prev.criteria || [],
    files:    prev.files || [],
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
  const d = card.draftTasks[idx] || (card.draftTasks[idx] = { title:'', desc:'', criteria:[], files:[], blockedBy:[] });
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
function evalLink(label, sub) {
  return `<div class="eval-link" onclick="alert('PROTOTYPE: opens the self-contained eval-plan HTML')"><span style="font-size:18px">📄</span>
    <div><b style="color:oklch(0.45 0.15 150)">${label}</b><div class="muted" style="font-size:12px">${sub}</div></div>
    <span style="margin-left:auto" class="muted">↗</span></div>`;
}

/* Two-column split: the review content on the left, a "Request changes"
   sidepanel on the right (instead of the AI chat the PRD/Tasks tabs use).
   Each change request is a simple editable/deletable text block. */
function reviewLayout(card, mainHtml) {
  return `<div class="prd-layout">
    <div class="prd-editor review-left">${mainHtml}</div>
    ${changeRequestsArea(card)}
  </div>`;
}

const TASK_QA_ITEMS = ['Streak of 1 renders correctly', 'DST day does not double-count', 'Timezone read from device'];
const FEATURE_QA_ITEMS = ['All child tasks pass their QA', 'Cross-task consistency checked', 'Combined narrative diff reviewed'];

/* QA checklist whose state drives the Approve button. Persisted on the card
   as `card.qa` (booleans, aligned to the items array). */
function qaListHtml(card, items) {
  if (!Array.isArray(card.qa) || card.qa.length !== items.length) {
    card.qa = items.map((_, i) => !!(card.qa && card.qa[i]));
  }
  return `<ul class="qa">${items.map((label, i) =>
    `<li><input type="checkbox" ${card.qa[i] ? 'checked' : ''} onchange="toggleQa('${card.id}',${i})"> ${esc(label)}</li>`).join('')}</ul>`;
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

/* The review action button. With pending change requests it becomes
   "Implement changes" (sends the card back to Implement). With none it's
   "Approve" — a secondary outline button until QA is complete, then a
   celebratory gradient button. */
function reviewActionsInner(card) {
  const changes = (card.changeRequests || []).length;
  if (changes > 0) {
    return `<button class="btn btn-primary issue-action-btn" onclick="implementChanges('${card.id}')">Implement changes →</button>`;
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

function taskReviewArea(card) {
  const main = `<div class="attn" style="margin-bottom:12px"><div class="h">⚠ ${card.flags || 0} attention flags</div>
    <ul><li><b>Deviation from plan</b> — added a caching layer not in the plan</li><li><b>Test gap</b> — no DST-day test</li></ul></div>`
    + evalLink('View evaluation plan', 'narrative diff · QA checklist · AI review · screenshots')
    + `<div class="sec-label" style="margin-top:12px">QA checklist</div>`
    + qaListHtml(card, TASK_QA_ITEMS);
  return reviewLayout(card, main);
}
function featureReviewArea(card) {
  const n = card.childCount || childrenOf(card).length;
  const main = `<div class="attn" style="margin-bottom:12px"><div class="h">⚠ ${card.flags || 0} attention flags across ${n} tasks</div>
    <ul>
      <li><b>Deviation from plan</b> — caching layer added in the API task</li>
      <li><b>Test gap</b> — no DST-day test in the calc task</li>
      <li><b>Consistency</b> — badge &amp; push tasks diverged on timezone helper</li>
    </ul></div>`
    + evalLink('View coherent evaluation plan', `rollup of ${n} tasks · combined narrative diff · aggregated QA · consolidated AI review`)
    + `<div class="sec-label" style="margin-top:14px">Per-task evaluation plans</div>`
    + `<div class="childcard">Streak calc API · <span class="muted">2 flags</span></div>`
    + `<div class="childcard">Streak UI badge · <span class="muted">0 flags</span></div>`
    + `<div class="sec-label" style="margin-top:14px">QA checklist</div>`
    + qaListHtml(card, FEATURE_QA_ITEMS);
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
  card.steps = mk(card.kind, 'finalize', { refactor: 'queued', document: 'pending', deploy: 'pending' });
  state.step = dialogStartIndex(card);
  state.editingCR = null;
  saveCards();
  App.repaintIssue();
}

/* "Implement changes" → send the card back to the Implement stage with the
   requested changes consumed. Tasks go back to the Implement column; a feature
   returns to Define Feature with its task slices re-queued for re-implementation. */
function implementChanges(cardId) {
  const card = cardById(cardId); if (!card) return;
  card.changeRequests = [];
  card.evalReady = false;
  if (card.kind === 'task-child' || card.kind === 'task-standalone') {
    card.col = 'implement';
    card.steps = mk(card.kind, 'implement', { plan: 'done', impl: 'queued', airev: 'pending' });
  } else {
    card.col = 'shape';
    card.steps = mk('feature', 'shape', { grill: 'done', prd: 'done', tasks: 'ai-working' });
    childrenOf(card).forEach(c => { const i = CARDS.indexOf(c); if (i !== -1) CARDS.splice(i, 1); });
    const drafts = card.draftTasks || defaultDraftTasks(card);
    drafts.forEach((d, idx) => {
      const id = 'tc' + (++nextCardId);
      CARDS.push({ id, col: 'implement', kind: 'task-child', parent: card.id, title: d.title, desc: d.desc,
        branch: `${card.branch || 'feat/new'}/card-${idx + 1}`,
        steps: mk('task-child', 'implement', { plan: 'queued', impl: 'pending', airev: 'pending' }) });
    });
    card.implProgress = { cur: 1, total: drafts.length };
  }
  state.step = dialogStartIndex(card);
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
    </div>`;
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
  // A task card (child or standalone) mid-Implement → simulate the AI finishing
  // its plan/impl/AI-review and hand it off to Human Review.
  if (card.col === 'implement' && (card.kind === 'task-child' || card.kind === 'task-standalone')) {
    return `<div class="wizard-foot">${del}<div style="flex:1"></div>
      <button class="btn btn-outline issue-action-btn" onclick="completeChildTask('${card.id}')">Simulate AI finished → review</button></div>`;
  }
  // Human Review tab → Approve / Implement changes (driven by the sidebar + QA).
  if (step.key === 'review') {
    return `<div class="wizard-foot">${del}<div style="flex:1"></div>
      <span id="review-actions">${reviewActionsInner(card)}</span></div>`;
  }
  return `<div class="wizard-foot">${del}</div>`;
}

/* =========================================================================
   BOARD
   ========================================================================= */
function renderBoard() {
  const cols = COLUMNS.map(col => {
    const body = (col.id === 'implement' || col.id === 'review') ? groupedColBody(col.id) : simpleColBody(col.id);
    return `<div class="col">
      <div class="col-wrap">
        <div class="col-head">
          <span class="name">${col.name}</span>
          ${col.id === 'backlog' ? `<button class="col-head-btn" onclick="addIssue()" title="Add to backlog">+</button>` : ''}
        </div>
        <div class="col-body">${body}</div>
      </div>
    </div>`;
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
  <div class="scroll"><div class="board">${cols}</div></div>`;
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
const state = { currentId: null, step: 0, editingCR: null };

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

/* Feature's "Implement" hand-off: spawn child task cards and turn Tasks orange. */
function implementTasks(featureId) {
  const card = cardById(featureId);
  if (!card) return;
  const drafts = card.draftTasks || defaultDraftTasks(card);
  drafts.forEach((d, idx) => {
    const id = 'tc' + (++nextCardId);
    CARDS.push({
      id, col: 'implement', kind: 'task-child', parent: card.id, title: d.title, desc: d.desc,
      branch: `${card.branch || 'feat/new'}/card-${idx + 1}`,
      steps: mk('task-child', 'implement', { plan: 'queued', impl: 'pending', airev: 'pending' })
    });
  });
  card.implProgress = { cur: 1, total: drafts.length };
  card.steps.find(s => s.key === 'tasks').status = 'ai-working';
  state.step = dialogStartIndex(card);
  saveCards();
  App.repaintIssue();
}

/* Simulate all children merged → Tasks done → feature auto-advances to review. */
function completeTasks(featureId) {
  const card = cardById(featureId);
  if (!card) return;
  childrenOf(card).forEach(c => { const i = CARDS.indexOf(c); if (i !== -1) CARDS.splice(i, 1); });
  card.childCount = card.implProgress?.total || childrenOf(card).length;
  card.col = 'review';
  card.evalReady = true;
  card.flags = card.flags || 2;
  card.steps = mk('feature', 'review', { grill: 'done', prd: 'done', tasks: 'done', review: 'needs-user' });
  card.qa = [true, false, false];
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
  card.steps = mk(kind, 'review', { review: 'needs-user' });
  card.qa = [true, false, false];
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
