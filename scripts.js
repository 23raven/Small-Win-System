(() => {
  "use strict";

  const STORAGE_KEY = "sws_v5";
  const LEGACY_STORAGE_KEYS = ["sws_v4", "sws_v3", "sws_v2"];

  const MILESTONES = [
    { minutes: 5, stars: 1, icon: "⭐", label: "First Star" },
    { minutes: 30, stars: 6, icon: "🥉", label: "Bronze" },
    { minutes: 60, stars: 12, icon: "🥈", label: "Silver" },
    { minutes: 120, stars: 24, icon: "🥇", label: "Gold" },
    { minutes: 240, stars: 48, icon: "👑", label: "Crown" },
    { minutes: 360, stars: 72, icon: "💎", label: "Diamond" }
  ];

  const defaultState = () => ({
    version: 3,
    settings: {
      focusMinutes: 5,
      focusStepMinutes: 5,
      starMinutes: 5,
      resetHour: 0,
      theme: "sky",
      github: {
        owner: "",
        repo: "",
        branch: "main",
        path: "data/sws-data.json",
        token: ""
      },
      notificationsEnabled: false
    },
    profile: {
      nickname: "SWS User",
      photo: ""
    },
    disciplines: [
      { id: "unity", name: "Unity", emoji: "🎮" },
      { id: "job", name: "Job Search", emoji: "💼" },
      { id: "blender", name: "Blender 3D", emoji: "🧊" },
      { id: "sport", name: "Sport", emoji: "🏋️" }
    ],
    rewards: [
      { id: "r1", emoji: "🐴", name: "BoJack S6 · EP 4", unlockAt: 5 },
      { id: "r2", emoji: "🐴", name: "BoJack S6 · EP 5", unlockAt: 10 },
      { id: "r3", emoji: "🐴", name: "BoJack S6 · EP 6", unlockAt: 15 },
      { id: "r4", emoji: "🐴", name: "BoJack S6 · EP 7", unlockAt: 20 },
      { id: "r5", emoji: "📺", name: "YouTube", unlockAt: 24 }
    ],
    tasks: [],
    selectedDisciplineId: "unity",
    selectedTaskId: null,
    today: {
      date: localDateKey(),
      stars: 0,
      sessions: 0,
      sessionsLog: []
    },
    history: {},
    globalDisciplineStars: {}
  });

  let state = loadState();
  let timerSeconds = state.settings.focusMinutes * 60;
  let timerRunning = false;
  let timerHandle = null;
  let lastTick = null;
  let timerDeadline = null;
  let activeTimerId = null;
  let timerWorker = null;
  let audioContext = null;
  let completionAudioBuffer = null;
  let scheduledSoundSource = null;
  let completionSoundLoadPromise = null;
  let observedNotificationPermission = null;

  initNotificationPermissionObserver();
  initTimerWorker();

  const $ = id => document.getElementById(id);

  let notificationServiceWorkerRegistration = null;
  initNotificationServiceWorker();

  function localDateKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function localDateLabel(date = new Date()) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short", year: "numeric", month: "short", day: "numeric"
    }).format(date);
  }

  function loadState() {
    try {
      const current = localStorage.getItem(STORAGE_KEY);
      if (current) return normalizeState(JSON.parse(current));

      for (const key of LEGACY_STORAGE_KEYS) {
        const previous = localStorage.getItem(key);
        if (previous) return migrateLegacy(JSON.parse(previous));
      }
    } catch (_) {}
    return defaultState();
  }

  function normalizeState(s) {
    const base = defaultState();
    const importedFocusMinutes =
      Number(s?.settings?.focusMinutes) ||
      (Number(s?.settings?.focusUnits) ? Number(s.settings.focusUnits) * 5 : 5);

    const importedFocusStepMinutes =
      Number(s?.settings?.focusStepMinutes) ||
      (Number(s?.settings?.focusStepUnits) ? Number(s.settings.focusStepUnits) * 5 : 5);

    const out = {
      ...base,
      ...s,
      settings: { ...base.settings, ...(s.settings || {}) },
      disciplines: Array.isArray(s.disciplines) && s.disciplines.length ? s.disciplines : base.disciplines,
      rewards: Array.isArray(s.rewards) ? s.rewards : base.rewards,
      tasks: Array.isArray(s.tasks) ? s.tasks : [],
      history: s.history || {},
      today: { ...base.today, ...(s.today || {}) },
      globalDisciplineStars: { ...(s.globalDisciplineStars || {}) },
      profile: { ...base.profile, ...(s.profile || {}) }
    };

    out.version = 6;
    out.profile.nickname = String(out.profile.nickname || "SWS User").trim().slice(0, 40) || "SWS User";
    out.profile.photo = typeof out.profile.photo === "string" ? out.profile.photo : "";
    out.settings.focusMinutes = sanitizeFocusMinutes(importedFocusMinutes);
    out.settings.focusStepMinutes = sanitizeFocusStep(importedFocusStepMinutes);
    out.settings.starMinutes = 5;
    out.settings.resetHour = clampInt(out.settings.resetHour, 0, 23);
    if (out.settings.theme === "apple") out.settings.theme = "sky";
    if (!["sky", "paper", "lavender"].includes(out.settings.theme)) out.settings.theme = "sky";

    out.rewards = out.rewards
      .filter(r => r && String(r.name || "").trim())
      .map((r, i) => ({
        id: r.id || `r-${Date.now()}-${i}`,
        emoji: String(r.emoji || "🎁").trim(),
        name: String(r.name).trim(),
        unlockAt: Math.max(1, Number(r.unlockAt) || 1)
      }));

    if (!out.rewards.length) out.rewards = base.rewards;
    out.rewards = enforceAscendingThresholds(out.rewards);

    const today = localDateKey();
    if (out.today.date !== today) {
      out.history[out.today.date] = {
        stars: Number(out.today.stars) || 0,
        sessions: Number(out.today.sessions) || 0,
        sessionsLog: Array.isArray(out.today.sessionsLog) ? out.today.sessionsLog : []
      };
      out.today = { date: today, stars: 0, sessions: 0, sessionsLog: [] };
    }

    if (!out.selectedDisciplineId || !out.disciplines.some(d => d.id === out.selectedDisciplineId)) {
      out.selectedDisciplineId = out.disciplines[0]?.id || null;
    }
    if (out.selectedTaskId && !out.tasks.some(t => t.id === out.selectedTaskId)) {
      out.selectedTaskId = null;
    }

    return out;
  }

  function migrateLegacy(old) {
    const base = defaultState();
    const oldFocusMinutes = Number(old?.settings?.focusMinutes) || (Number(old?.settings?.focusUnits) ? Number(old.settings.focusUnits) * 5 : 5);
    return normalizeState({
      ...base,
      ...old,
      settings: {
        ...base.settings,
        ...(old?.settings || {}),
        focusMinutes: sanitizeFocusMinutes(oldFocusMinutes),
        focusStepMinutes: sanitizeFocusStep((Number(old?.settings?.focusStepMinutes) || (Number(old?.settings?.focusStepUnits) || 1) * 5))
      },
      profile: old?.profile || base.profile,
      disciplines: old?.disciplines || base.disciplines,
      rewards: old?.rewards || base.rewards,
      tasks: old?.tasks || [],
      selectedDisciplineId: old?.selectedDisciplineId || base.selectedDisciplineId,
      selectedTaskId: old?.selectedTaskId || null,
      today: old?.today || base.today,
      history: old?.history || {},
      globalDisciplineStars: old?.globalDisciplineStars || {}
    });
  }

  function sanitizeFocusMinutes(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 5;
    return Math.min(60, Math.max(1, Math.round(n)));
  }

  function sanitizeFocusStep(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 5;
    return Math.min(60, Math.max(1, Math.round(n)));
  }

  function clampInt(n, min, max) {
    n = Number(n);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function enforceAscendingThresholds(rewards) {
    let previous = 0;
    return rewards.map(r => {
      const threshold = Math.max(previous + 1, Math.round(Number(r.unlockAt) || previous + 1));
      previous = threshold;
      return { ...r, unlockAt: threshold };
    });
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function ensureDay() {
    const today = localDateKey();
    if (state.today.date !== today) {
      state.history[state.today.date] = {
        stars: state.today.stars,
        sessions: state.today.sessions,
        sessionsLog: state.today.sessionsLog
      };
      state.today = { date: today, stars: 0, sessions: 0, sessionsLog: [] };
      persist();
      resetTimer();
      closeAllModals();
      toast("New SWS day. Balance reset to 0 ⭐.");
    }
  }

  function disciplineById(id) {
    return state.disciplines.find(d => d.id === id);
  }

  function currentRewardIndex() {
    return state.rewards.findIndex(r => state.today.stars < r.unlockAt);
  }

  function currentMilestone() {
    let reached = null;
    for (const m of MILESTONES) {
      if (state.today.stars * 5 >= m.minutes) reached = m;
    }
    return reached;
  }

  function nextMilestone() {
    return MILESTONES.find(m => state.today.stars * 5 < m.minutes) || null;
  }

  function renderAll() {
    ensureDay();
    document.documentElement.dataset.theme = state.settings.theme;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = state.settings.theme === "sky" ? "#f4f9ff" : state.settings.theme === "paper" ? "#fbfaf7" : "#f8f7fc";
    renderHeader();
    renderProgress();
    renderDisciplines();
    renderTasks();
    renderSelectedActivity();
    renderRewards();
    renderDisciplineStats();
    renderSessionLog();
    renderHistory();
    renderProfile();
    renderSettingsSummary();
    updateTimerUI();
  }

  function renderHeader() {
    $("todayLabel").textContent = localDateLabel();
    $("footerFocusText").textContent = `Focus Unit: ${state.settings.focusMinutes} ${state.settings.focusMinutes === 1 ? "minute" : "minutes"}`;
  }

  function renderProgress() {
    const stars = state.today.stars;
    const minutes = stars * 5;
    const reached = currentMilestone();
    const next = nextMilestone();

    $("dailyStarsTitle").textContent = `${formatStars(stars)} ⭐`;
    $("dailyMinutesTitle").textContent = `${minutes} minute${minutes === 1 ? "" : "s"} useful activity`;
    $("heroTierIcon").textContent = reached?.icon || "⭐";

    const status = $("dayStatus");
    status.textContent = stars > 0 ? "NON-ZERO" : "ZERO";
    status.classList.toggle("non-zero", stars > 0);

    if (reached) {
      $("currentMilestoneLabel").textContent = `${reached.icon} ${reached.label} · ${reached.minutes} min`;
    } else {
      $("currentMilestoneLabel").textContent = "No milestone reached yet";
    }

    if (next) {
      const prior = reached?.minutes || 0;
      const span = Math.max(1, next.minutes - prior);
      const within = Math.max(0, minutes - prior);
      $("milestoneMeterFill").style.width = `${Math.min(100, (within / span) * 100)}%`;
      $("nextMilestoneText").textContent = `${next.minutes - minutes} min to ${next.icon} ${next.label}`;
    } else {
      $("milestoneMeterFill").style.width = "100%";
      $("nextMilestoneText").textContent = "💎 Diamond reached";
    }

    $("milestones").innerHTML = MILESTONES.map(m => {
      const reachedNow = minutes >= m.minutes;
      const isNext = !reachedNow && (!next || m.minutes === next.minutes);
      return `
        <div class="milestone ${reachedNow ? "reached" : ""} ${isNext ? "next" : ""}">
          <div class="milestone-icon">${m.icon}</div>
          <div class="milestone-time">${m.minutes} minutes</div>
          <div class="milestone-stars">⭐ ×${m.stars}</div>
        </div>
      `;
    }).join("");
  }

  function renderDisciplines() {
    const selected = state.selectedDisciplineId;

    $("disciplineList").innerHTML = state.disciplines.map(d => {
      const stars = state.today.sessionsLog
        .filter(x => x.disciplineId === d.id)
        .reduce((sum, x) => sum + x.stars, 0);

      return `
        <button class="discipline-item ${selected === d.id ? "active" : ""}" data-discipline="${escapeHtml(d.id)}">
          <span class="discipline-main">
            <span class="discipline-emoji">${escapeHtml(d.emoji)}</span>
            <span class="discipline-name">${escapeHtml(d.name)}</span>
          </span>
          <span class="discipline-time">${formatStars(stars)} ⭐</span>
        </button>
      `;
    }).join("");

    document.querySelectorAll("[data-discipline]").forEach(btn => {
      btn.addEventListener("click", () => {
        state.selectedDisciplineId = btn.dataset.discipline;
        state.selectedTaskId = null;
        persist();
        renderAll();
      });
    });

    $("taskDisciplineSelect").innerHTML = state.disciplines.map(d =>
      `<option value="${escapeHtml(d.id)}" ${d.id === selected ? "selected" : ""}>${escapeHtml(d.emoji)} ${escapeHtml(d.name)}</option>`
    ).join("");
  }

  function renderTasks() {
    const tasks = state.tasks
      .filter(t => t.disciplineId === state.selectedDisciplineId)
      .sort((a,b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);

    if (!tasks.length) {
      $("taskList").innerHTML = `<div class="empty-state">No tasks here yet. Add one above.</div>`;
      return;
    }

    $("taskList").innerHTML = tasks.map(t => `
      <div class="task-item ${state.selectedTaskId === t.id ? "selected" : ""}">
        <button class="task-check ${t.done ? "done" : ""}" data-toggle-task="${escapeHtml(t.id)}">${t.done ? "✓" : ""}</button>
        <button class="task-title ${t.done ? "done" : ""}" data-select-task="${escapeHtml(t.id)}" title="Select task">${escapeHtml(t.title)}</button>
        <button class="ghost small" data-delete-task="${escapeHtml(t.id)}" title="Delete task">✕</button>
      </div>
    `).join("");

    document.querySelectorAll("[data-toggle-task]").forEach(btn => btn.addEventListener("click", () => {
      const task = state.tasks.find(t => t.id === btn.dataset.toggleTask);
      if (!task) return;
      task.done = !task.done;
      persist();
      renderTasks();
    }));

    document.querySelectorAll("[data-select-task]").forEach(btn => btn.addEventListener("click", () => {
      state.selectedTaskId = btn.dataset.selectTask;
      persist();
      renderAll();
    }));

    document.querySelectorAll("[data-delete-task]").forEach(btn => btn.addEventListener("click", () => {
      state.tasks = state.tasks.filter(t => t.id !== btn.dataset.deleteTask);
      if (state.selectedTaskId === btn.dataset.deleteTask) state.selectedTaskId = null;
      persist();
      renderAll();
    }));
  }

  function renderSelectedActivity() {
    const d = disciplineById(state.selectedDisciplineId);
    const t = state.tasks.find(x => x.id === state.selectedTaskId);
    $("selectedActivity").textContent = d
      ? `${d.emoji} ${d.name} · ${t ? t.title : "No task selected"}`
      : "No discipline selected";
  }

  function renderRewards() {
    const idx = currentRewardIndex();
    const current = idx >= 0 ? state.rewards[idx] : null;

    if (!current) {
      const last = state.rewards[state.rewards.length - 1];
      $("currentReward").innerHTML = `
        <div class="reward-kicker">QUEUE COMPLETE</div>
        <div class="reward-name">All rewards unlocked.</div>
        <div class="reward-count">${state.today.stars} ⭐ earned today${last ? ` · last unlock at ${last.unlockAt} ⭐` : ""}.</div>
      `;
    } else {
      const previous = idx > 0 ? state.rewards[idx - 1].unlockAt : 0;
      const currentProgress = Math.max(0, state.today.stars - previous);
      const currentNeed = Math.max(1, current.unlockAt - previous);
      const starsToGo = Math.max(0, current.unlockAt - state.today.stars);
      const visibleStars = Math.min(10, currentNeed);
      const progressStars = Math.min(visibleStars, Math.floor(currentProgress));

      $("currentReward").innerHTML = `
        <div class="reward-kicker">NEXT REWARD · ${starsToGo} ⭐ TO GO</div>
        <div class="reward-name">${escapeHtml(current.emoji)} ${escapeHtml(current.name)}</div>
        <div class="reward-progress">
          ${Array.from({length: visibleStars}, (_,i) =>
            `<span class="reward-star ${i < progressStars ? "active" : ""}">★</span>`
          ).join("")}
        </div>
        <div class="reward-count">${formatStars(state.today.stars)} / ${current.unlockAt} total Stars</div>
      `;
    }

    $("rewardList").innerHTML = state.rewards.map((r, i) => {
      const unlocked = state.today.stars >= r.unlockAt;
      const isNext = i === idx;
      return `
        <div class="reward-row ${unlocked ? "unlocked" : ""} ${isNext ? "next" : ""}">
          <div class="reward-number">#${i + 1}</div>
          <div class="reward-emoji">${escapeHtml(r.emoji)}</div>
          <div class="reward-text">${escapeHtml(r.name)}</div>
          <div class="reward-threshold">${unlocked ? "OPEN" : `${r.unlockAt} ⭐`}</div>
        </div>
      `;
    }).join("");
  }

  function renderDisciplineStats() {
    const totals = state.disciplines.map(d => ({
      ...d,
      stars: state.today.sessionsLog
        .filter(x => x.disciplineId === d.id)
        .reduce((sum,x) => sum + x.stars, 0)
    }));

    const max = Math.max(1, ...totals.map(x => x.stars));
    $("disciplineStats").innerHTML = totals.map(d => `
      <div class="stat-row">
        <div class="stat-top">
          <span class="stat-name">${escapeHtml(d.emoji)} ${escapeHtml(d.name)}</span>
          <span class="stat-value">${formatStars(d.stars)} ⭐ · ${d.stars * 5} min</span>
        </div>
        <div class="stat-track"><div class="stat-fill" style="width:${(d.stars / max) * 100}%"></div></div>
      </div>
    `).join("");
  }


  function renderSessionLog() {
    const rows = [...state.today.sessionsLog].reverse();
    if (!rows.length) {
      $("sessionLog").innerHTML = `<div class="empty-state">No focus units yet today.</div>`;
      return;
    }

    $("sessionLog").innerHTML = rows.slice(0, 60).map(x => {
      const d = disciplineById(x.disciplineId);
      const mins = Number(x.minutes) || Number(x.stars) * 5;
      return `
        <div class="log-row">
          <div class="log-time">${escapeHtml(x.time)}</div>
          <div>${escapeHtml(d?.emoji || "•")}</div>
          <div class="log-task">${escapeHtml(x.taskTitle || "No task selected")}</div>
          <div class="log-star">+${x.stars} ⭐ · ${mins}m</div>
        </div>
      `;
    }).join("");
  }

  function getHistoryEntry(key) {
    return key === state.today.date
      ? { stars: state.today.stars, sessions: state.today.sessions }
      : (state.history[key] || { stars: 0, sessions: 0 });
  }

  let historyView = localStorage.getItem("sws_history_view") || "classic";

  function renderHistory() {
    document.querySelectorAll("[data-history-view]").forEach(btn =>
      btn.classList.toggle("active", btn.dataset.historyView === historyView)
    );

    const caption = {
      classic: "Recent days at a glance",
      contributions: "GitHub-style activity over the last year",
      graph: "A Screen Time-style view of your recent days"
    }[historyView] || "Recent days at a glance";
    $("historyCaption").textContent = caption;

    if (historyView === "contributions") renderContributionHistory();
    else if (historyView === "graph") renderGraphHistory();
    else renderClassicHistory();
  }

  function renderClassicHistory() {
    const cells = [];
    const now = new Date();
    for (let i = 0; i < 21; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = localDateKey(d);
      const e = getHistoryEntry(key);
      cells.push(`
        <div class="history-day ${e.stars > 0 ? "nonzero" : ""}">
          <div class="history-date">${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
          <div class="history-stars">${formatStars(e.stars || 0)} ⭐</div>
          <div class="history-hours">${((e.stars || 0) * 5 / 60).toFixed(1)} h · ${e.sessions || 0} units</div>
        </div>`);
    }
    $("historyContent").innerHTML = `<div class="history-grid">${cells.join("")}</div>`;
  }

  function contributionLevel(stars) {
    if (stars <= 0) return 0;
    if (stars < 6) return 1;
    if (stars < 12) return 2;
    if (stars < 24) return 3;
    return 4;
  }

  function renderContributionHistory() {
    const weeks = 53;
    const end = new Date();
    end.setHours(12,0,0,0);
    const start = new Date(end);
    start.setDate(end.getDate() - 364);
    const day = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - day); // Monday

    const columns = [];
    const monthLabels = [];
    let maxStars = 0;

    for (let w = 0; w < weeks; w++) {
      const days = [];
      const weekStart = new Date(start);
      weekStart.setDate(start.getDate() + w * 7);
      for (let r = 0; r < 7; r++) {
        const d = new Date(weekStart);
        d.setDate(weekStart.getDate() + r);
        const key = localDateKey(d);
        const e = getHistoryEntry(key);
        maxStars = Math.max(maxStars, e.stars || 0);
        days.push({ d, e });
      }
      columns.push(days);
      const month = weekStart.toLocaleDateString(undefined, { month: "short" });
      if (w === 0 || columns[w-1]?.[0]?.d.toLocaleDateString(undefined, {month:"short"}) !== month) {
        monthLabels.push({ w: w + 2, label: month });
      }
    }

    const labels = ["", "Mon", "", "Wed", "", "Fri", ""];
    const monthGrid = `<div class="contribution-months"><div></div>${Array.from({length: weeks}, (_,w) => {
      const found = monthLabels.find(x => x.w === w + 2);
      return `<div class="month">${found ? found.label : ""}</div>`;
    }).join("")}</div>`;

    const grid = `<div class="contribution-grid"><div class="contribution-labels">${labels.map(x => `<span>${x}</span>`).join("")}</div>${columns.map(col =>
      `<div class="contribution-col">${col.map(({d,e}) => {
        const level = contributionLevel(e.stars || 0);
        return `<div class="contribution-cell level-${level}" title="${localDateKey(d)} · ${formatStars(e.stars || 0)} ⭐"></div>`;
      }).join("")}</div>`
    ).join("")}</div>`;

    $("historyContent").innerHTML = `
      <div class="contribution-wrap">
        <div class="contribution-topline"><span>Last 365 days</span><strong>${maxStars} ⭐ best day</strong></div>
        ${monthGrid}
        ${grid}
        <div class="contribution-legend"><span>Less</span><span class="legend-cell"></span><span class="legend-cell level-1"></span><span class="legend-cell level-2"></span><span class="legend-cell level-3"></span><span class="legend-cell level-4"></span><span>More</span></div>
      </div>`;
  }

  function renderGraphHistory() {
    const days = [];
    const now = new Date();
    let total = 0;
    let max = 0;
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const e = getHistoryEntry(localDateKey(d));
      const mins = (e.stars || 0) * 5;
      total += mins;
      max = Math.max(max, mins);
      days.push({ d, e, mins });
    }
    const scale = Math.max(60, Math.ceil(max / 60) * 60);
    const maxHours = scale / 60;
    const bars = days.map(({d, mins}) => {
      const pct = Math.min(100, (mins / scale) * 100);
      return `<div class="graph-bar-col"><div class="graph-bar" style="height:${Math.max(2, pct)}%" title="${localDateKey(d)} · ${(mins/60).toFixed(1)} h"></div><div class="graph-bar-label">${d.toLocaleDateString(undefined,{weekday:"short"}).slice(0,2)}</div></div>`;
    }).join("");

    $("historyContent").innerHTML = `
      <div class="graph-wrap">
        <div class="graph-summary"><div><div class="graph-total">${(total/60).toFixed(1)} h</div><div class="graph-sub">useful activity in the last 14 days</div></div><div class="graph-sub">Peak scale: ${maxHours} h/day</div></div>
        <div class="graph-chart"><div class="graph-y"><span>${maxHours}h</span><span>${(maxHours/2).toFixed(0)}h</span><span>0h</span></div><div class="graph-bars">${bars}</div></div>
      </div>`;
  }


  function allTimeStats() {
    const byDiscipline = state.disciplines.map(d => ({
      ...d,
      stars: Number(state.globalDisciplineStars?.[d.id] || 0)
    }));
    const totalStars = byDiscipline.reduce((sum, d) => sum + d.stars, 0);
    const historyEntries = Object.entries(state.history || {});
    const nonZeroDays = historyEntries.filter(([,e]) => Number(e?.stars || 0) > 0).length + (state.today.stars > 0 ? 1 : 0);
    const bestDay = historyEntries.reduce((best, [,e]) => Math.max(best, Number(e?.stars || 0)), state.today.stars || 0);
    return { byDiscipline, totalStars, totalMinutes: totalStars * 5, nonZeroDays, bestDay };
  }

  function initialsFor(name) {
    const words = String(name || "SWS User").trim().split(/\s+/).filter(Boolean);
    return (words.slice(0,2).map(x => x[0]).join("") || "S").toUpperCase();
  }

  function renderProfile() {
    const p = state.profile || { nickname: "SWS User", photo: "" };
    const initials = initialsFor(p.nickname);
    $("miniProfileName").textContent = p.nickname;
    $("miniProfileInitials").textContent = initials;
    $("profileInitials").textContent = initials;

    const hasPhoto = Boolean(p.photo);
    $("miniProfilePhoto").classList.toggle("hidden", !hasPhoto);
    $("miniProfileInitials").classList.toggle("hidden", hasPhoto);
    if (hasPhoto) $("miniProfilePhoto").src = p.photo;

    $("profilePhotoPreview").classList.toggle("hidden", !hasPhoto);
    $("profileInitials").classList.toggle("hidden", hasPhoto);
    if (hasPhoto) $("profilePhotoPreview").src = p.photo;

    $("profileNicknameInput").value = p.nickname;

    const stats = allTimeStats();
    $("profileStatsGrid").innerHTML = [
      ["⭐", stats.totalStars, "Total Stars"],
      ["⏱️", `${(stats.totalMinutes/60).toFixed(1)}h`, "Useful activity"],
      ["📅", stats.nonZeroDays, "Non-Zero Days"],
      ["🏆", stats.bestDay, "Best day · Stars"]
    ].map(([icon,value,label]) => `<div class="profile-stat"><div class="profile-stat-value">${icon} ${value}</div><div class="profile-stat-label">${label}</div></div>`).join("");

    const max = Math.max(1, ...stats.byDiscipline.map(x => x.stars));
    $("profileDisciplineStats").innerHTML = stats.byDiscipline.map(d => `
      <div class="stat-row">
        <div class="stat-top"><span class="stat-name">${escapeHtml(d.emoji)} ${escapeHtml(d.name)}</span><span class="stat-value">${d.stars} ⭐ · ${d.stars*5} min</span></div>
        <div class="stat-track"><div class="stat-fill" style="width:${(d.stars/max)*100}%"></div></div>
      </div>`).join("");

    const recent = [];
    for (let i=0;i<7;i++) {
      const d=new Date(); d.setDate(d.getDate()-i);
      const e=getHistoryEntry(localDateKey(d));
      recent.push(`<div class="profile-day-chip"><strong>${e.stars||0} ⭐</strong><span>${d.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"})}</span></div>`);
    }
    $("profileMiniHistory").innerHTML = recent.join("");
  }

  function openProfile() {
    renderProfile();
    $("profileModal").classList.remove("hidden");
  }

  function closeProfile() { $("profileModal").classList.add("hidden"); }

  function saveProfile() {
    const name = $("profileNicknameInput").value.trim();
    state.profile.nickname = name || "SWS User";
    persist();
    if (state.settings.github?.owner && state.settings.github?.repo && state.settings.github?.token) githubPutState().catch(()=>{});
    renderProfile();
    renderHeader();
    closeProfile();
    toast("Profile saved.");
  }

  function removeProfilePhoto() {
    state.profile.photo = "";
    renderProfile();
  }

  async function handleProfilePhoto(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast("Choose an image file."); return; }
    try {
      const data = await resizeImage(file, 256, 0.82);
      state.profile.photo = data;
      persist();
      renderProfile();
      toast("Photo updated. Save the profile to keep it.");
    } catch (_) {
      toast("Could not process that photo.");
    }
  }

  function resizeImage(file, size, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2;
          const sy = (img.height - side) / 2;
          const canvas = document.createElement("canvas");
          canvas.width = size; canvas.height = size;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderSettingsSummary() {
    if (state.settings.theme === "apple") state.settings.theme = "sky";
    $("themeInput").value = state.settings.theme;
    $("focusStepInput").value = String(state.settings.focusStepMinutes);
    $("resetHourInput").innerHTML = Array.from({length:24}, (_,h) =>
      `<option value="${h}" ${h === state.settings.resetHour ? "selected" : ""}>${String(h).padStart(2,"0")}:00 local time</option>`
    ).join("");

    $("focusStepInput").innerHTML = Array.from({length:60}, (_,i) => {
      const value = i + 1;
      return `<option value="${value}" ${value === state.settings.focusStepMinutes ? "selected" : ""}>${value} ${value === 1 ? "minute" : "minutes"}</option>`;
    }).join("");

    const gh = state.settings.github || {};
    $("syncSummary").textContent = gh.owner && gh.repo
      ? `Connected to ${gh.owner}/${gh.repo} · ${gh.path || "data/sws-data.json"}`
      : "Optional cloud save for GitHub Pages.";

    renderNotificationState();
  }

  function renderRewardEditor() {
    $("rewardSettings").innerHTML = state.rewards.map((r, i) => `
      <div class="reward-editor-row">
        <div class="reward-order">#${i + 1}</div>
        <button type="button" class="emoji-input emoji-button" data-reward-emoji="${escapeHtml(r.id)}" aria-label="Choose reward emoji">${escapeHtml(r.emoji)}</button>
        <input data-reward-name="${escapeHtml(r.id)}" value="${escapeHtml(r.name)}" aria-label="Reward name" />
        <input class="threshold-input" data-reward-threshold="${escapeHtml(r.id)}" type="number" min="1" step="1" value="${r.unlockAt}" aria-label="Unlock Stars" />
        <div class="row-actions">
          <button class="ghost small" data-move-reward-up="${escapeHtml(r.id)}" title="Move up">↑</button>
          <button class="ghost small" data-move-reward-down="${escapeHtml(r.id)}" title="Move down">↓</button>
          <button class="ghost small" data-remove-reward="${escapeHtml(r.id)}" title="Remove">Remove</button>
        </div>
      </div>
    `).join("");

    document.querySelectorAll("[data-move-reward-up]").forEach(btn =>
      btn.addEventListener("click", () => moveReward(btn.dataset.moveRewardUp, -1))
    );
    document.querySelectorAll("[data-move-reward-down]").forEach(btn =>
      btn.addEventListener("click", () => moveReward(btn.dataset.moveRewardDown, 1))
    );
    document.querySelectorAll("[data-remove-reward]").forEach(btn =>
      btn.addEventListener("click", () => {
        if (state.rewards.length <= 1) {
          toast("Keep at least one reward.");
          return;
        }
        state.rewards = state.rewards.filter(r => r.id !== btn.dataset.removeReward);
        state.rewards = enforceAscendingThresholds(state.rewards);
        renderRewardEditor();
      })
    );

    document.querySelectorAll("[data-reward-emoji]").forEach(btn =>
      btn.addEventListener("click", () => openEmojiPicker(btn))
    );
  }

  function renderDisciplineEditor() {
    $("disciplineSettings").innerHTML = state.disciplines.map(d => `
      <div class="discipline-setting">
        <button type="button" class="emoji-input emoji-button" data-edit-discipline-emoji="${escapeHtml(d.id)}" aria-label="Choose discipline emoji">${escapeHtml(d.emoji)}</button>
        <input data-edit-discipline-name="${escapeHtml(d.id)}" value="${escapeHtml(d.name)}" aria-label="Discipline name" />
        <button class="ghost small" data-remove-discipline="${escapeHtml(d.id)}">Remove</button>
      </div>
    `).join("");

    document.querySelectorAll("[data-edit-discipline-emoji]").forEach(btn =>
      btn.addEventListener("click", () => openEmojiPicker(btn))
    );

    document.querySelectorAll("[data-remove-discipline]").forEach(btn => btn.addEventListener("click", () => {
      if (state.disciplines.length <= 1) {
        toast("Keep at least one discipline.");
        return;
      }

      const id = btn.dataset.removeDiscipline;
      state.disciplines = state.disciplines.filter(d => d.id !== id);
      state.tasks = state.tasks.filter(t => t.disciplineId !== id);

      if (state.selectedDisciplineId === id) {
        state.selectedDisciplineId = state.disciplines[0].id;
        state.selectedTaskId = null;
      }

      renderDisciplineEditor();
    }));
  }

  function applyRewardEditorInputs() {
    const updated = state.rewards.map(r => {
      const name = document.querySelector(`[data-reward-name="${CSS.escape(r.id)}"]`);
      const emoji = document.querySelector(`[data-reward-emoji="${CSS.escape(r.id)}"]`);
      const threshold = document.querySelector(`[data-reward-threshold="${CSS.escape(r.id)}"]`);

      return {
        ...r,
        name: name?.value.trim() || r.name,
        emoji: emoji?.textContent.trim() || r.emoji,
        unlockAt: Math.max(1, Number(threshold?.value) || r.unlockAt)
      };
    });

    state.rewards = enforceAscendingThresholds(updated);
  }

  function applyDisciplineEditorInputs() {
    state.disciplines = state.disciplines.map(d => {
      const name = document.querySelector(`[data-edit-discipline-name="${CSS.escape(d.id)}"]`);
      const emoji = document.querySelector(`[data-edit-discipline-emoji="${CSS.escape(d.id)}"]`);

      return {
        ...d,
        name: name?.value.trim() || d.name,
        emoji: emoji?.textContent.trim() || d.emoji
      };
    });
  }

  function moveReward(id, delta) {
    applyRewardEditorInputs();

    const idx = state.rewards.findIndex(r => r.id === id);
    const to = idx + delta;
    if (idx < 0 || to < 0 || to >= state.rewards.length) {
      renderRewardEditor();
      return;
    }

    [state.rewards[idx], state.rewards[to]] = [state.rewards[to], state.rewards[idx]];

    // Keep the threshold positions stable when changing queue order.
    const oldThreshold = state.rewards[idx].unlockAt;
    state.rewards[idx].unlockAt = state.rewards[to].unlockAt;
    state.rewards[to].unlockAt = oldThreshold;

    renderRewardEditor();
  }

  function addReward() {
    applyRewardEditorInputs();

    const emoji = $("newRewardEmoji").textContent.trim() || "🎁";
    const name = $("newRewardName").value.trim();
    if (!name) {
      toast("Give the reward a name.");
      return;
    }

    const lastThreshold = state.rewards.at(-1)?.unlockAt || 0;
    const requested = Math.max(lastThreshold + 1, Number($("newRewardThreshold").value) || lastThreshold + 5);

    state.rewards.push({
      id: makeId("reward"),
      emoji,
      name,
      unlockAt: requested
    });

    $("newRewardEmoji").textContent = "🎁";
    $("newRewardName").value = "";
    $("newRewardThreshold").value = "";

    renderRewardEditor();
  }

  function addDiscipline() {
    applyDisciplineEditorInputs();

    const name = $("newDisciplineName").value.trim();
    const emoji = $("newDisciplineEmoji").textContent.trim() || "🧩";
    if (!name) {
      toast("Give the discipline a name.");
      return;
    }

    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
    state.disciplines.push({ id, name, emoji });
    state.selectedDisciplineId = id;
    state.selectedTaskId = null;

    $("newDisciplineName").value = "";
    $("newDisciplineEmoji").textContent = "🧩";

    renderDisciplineEditor();
    renderAll();
  }

  function changeFocusUnits(direction) {
    if (timerRunning) return;

    const step = state.settings.focusStepMinutes;
    state.settings.focusMinutes = sanitizeFocusMinutes(state.settings.focusMinutes + (direction * step));
    persist();

    if (state.settings.github?.owner && state.settings.github?.repo && state.settings.github?.token) {
      githubPutState().catch(() => {});
    }

    timerSeconds = state.settings.focusMinutes * 60;
    updateTimerUI();
    renderHeader();
  }

  function addTask() {
    const title = $("taskInput").value.trim();
    const disciplineId = $("taskDisciplineSelect").value;
    if (!title) return;

    const task = {
      id: makeId("task"),
      title,
      disciplineId,
      done: false,
      createdAt: Date.now()
    };

    state.tasks.push(task);
    state.selectedDisciplineId = disciplineId;
    state.selectedTaskId = task.id;
    $("taskInput").value = "";

    persist();
    renderAll();
  }

  async function initNotificationPermissionObserver() {
    if (typeof Notification === "undefined") return;

    observedNotificationPermission = Notification.permission;
    if (Notification.permission === "granted") {
      state.settings.notificationsEnabled = true;
      persist();
    }

    if (!navigator.permissions?.query) return;

    try {
      const permissionStatus = await navigator.permissions.query({ name: "notifications" });
      observedNotificationPermission = permissionStatus.state;
      if (permissionStatus.state === "granted") {
        state.settings.notificationsEnabled = true;
        persist();
      }
      permissionStatus.addEventListener?.("change", () => {
        observedNotificationPermission = permissionStatus.state;
        state.settings.notificationsEnabled = permissionStatus.state === "granted";
        persist();
        renderNotificationState();
      });
    } catch (_) {}
  }

  function initTimerWorker() {
    try {
      timerWorker = new Worker(new URL("sws-timer-worker.js", window.location.href));
      timerWorker.addEventListener("message", event => {
        const data = event.data || {};
        if (data.type !== "complete" || !timerRunning || data.timerId !== activeTimerId) return;

        // Completion is handled immediately by the page while it is alive.
        // The notification itself is sent through the Service Worker.
        completeSession({ fromBackgroundWorker: true });
      });
      timerWorker.addEventListener("error", () => {
        // UI timer remains the fallback if the worker is unavailable.
        timerWorker = null;
      });
    } catch (_) {
      timerWorker = null;
    }
  }

  async function initNotificationServiceWorker() {
    if (!window.isSecureContext || !("serviceWorker" in navigator)) return;

    try {
      notificationServiceWorkerRegistration = await navigator.serviceWorker.register(
        new URL("sws-notification-sw.js", window.location.href),
        { scope: "./" }
      );
      await navigator.serviceWorker.ready;
      renderNotificationState();
    } catch (_) {
      notificationServiceWorkerRegistration = null;
      renderNotificationState();
    }
  }

  function postWorkerStart() {
    if (!timerWorker || !timerDeadline || !activeTimerId) return;
    try {
      timerWorker.postMessage({
        type: "start",
        timerId: activeTimerId,
        deadline: timerDeadline
      });
    } catch (_) {}
  }

  function postWorkerCancel() {
    if (!timerWorker) return;
    try { timerWorker.postMessage({ type: "cancel", timerId: activeTimerId }); } catch (_) {}
  }

  function toggleTimer() {
    ensureDay();

    if (timerRunning) {
      pauseTimer();
      return;
    }

    timerRunning = true;
    const remaining = Math.max(1, Math.ceil(timerSeconds));
    timerDeadline = Date.now() + remaining * 1000;
    activeTimerId = makeId("timer");

    primeCompletionSound();
    scheduleCompletionSound(remaining);
    postWorkerStart();

    lastTick = performance.now();
    $("startPauseBtn").textContent = "Pause";
    $("currentMode").textContent = "Running";
    $("timer").classList.add("running");
    $("decreaseUnitsBtn").disabled = true;
    $("increaseUnitsBtn").disabled = true;

    timerHandle = requestAnimationFrame(tick);
  }

  function pauseTimer() {
    if (!timerRunning) return;

    timerSeconds = timerDeadline
      ? Math.max(0, (timerDeadline - Date.now()) / 1000)
      : timerSeconds;

    timerRunning = false;
    if (timerHandle) cancelAnimationFrame(timerHandle);
    timerHandle = null;
    lastTick = null;
    timerDeadline = null;
    postWorkerCancel();
    stopScheduledSound();

    $("startPauseBtn").textContent = "Resume";
    $("currentMode").textContent = "Paused";
    $("timer").classList.remove("running");
    $("decreaseUnitsBtn").disabled = false;
    $("increaseUnitsBtn").disabled = false;
    updateTimerUI();
  }

  function resetTimer() {
    timerRunning = false;
    if (timerHandle) cancelAnimationFrame(timerHandle);
    timerHandle = null;
    lastTick = null;
    timerDeadline = null;
    postWorkerCancel();
    stopScheduledSound();
    timerSeconds = state.settings.focusMinutes * 60;
    $("startPauseBtn").textContent = "Start";
    $("currentMode").textContent = "Ready";
    $("timer").classList.remove("running");
    $("decreaseUnitsBtn").disabled = false;
    $("increaseUnitsBtn").disabled = false;
    updateTimerUI();
  }

  function tick() {
    if (!timerRunning) return;

    const remainingMs = timerDeadline ? timerDeadline - Date.now() : 0;
    timerSeconds = Math.max(0, remainingMs / 1000);

    if (remainingMs <= 0) {
      timerSeconds = 0;
      completeSession({ notificationAlreadyShown: false });
      return;
    }

    updateTimerUI();
    timerHandle = requestAnimationFrame(tick);
  }

  function ensureAudioContext() {
    if (audioContext) return audioContext;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      audioContext = new Ctx();
      return audioContext;
    } catch (_) {
      return null;
    }
  }

  async function loadCompletionAudioBuffer() {
    if (completionAudioBuffer) return completionAudioBuffer;
    if (completionSoundLoadPromise) return completionSoundLoadPromise;

    completionSoundLoadPromise = fetch("notification.mp3")
      .then(res => {
        if (!res.ok) throw new Error(`notification.mp3 failed (${res.status})`);
        return res.arrayBuffer();
      })
      .then(bytes => {
        const ctx = ensureAudioContext();
        if (!ctx) return null;
        return ctx.decodeAudioData(bytes);
      })
      .then(buffer => {
        completionAudioBuffer = buffer;
        return buffer;
      })
      .catch(() => null);

    return completionSoundLoadPromise;
  }

  async function scheduleCompletionSound(delaySeconds) {
    const ctx = ensureAudioContext();
    if (!ctx || !timerRunning) return;

    try { await ctx.resume(); } catch (_) {}

    const buffer = await loadCompletionAudioBuffer();
    if (!buffer || !timerRunning || !timerDeadline) return;

    stopScheduledSound();
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (scheduledSoundSource === source) scheduledSoundSource = null;
      };
      source.start(ctx.currentTime + Math.max(0.01, delaySeconds));
      scheduledSoundSource = source;
    } catch (_) {}
  }

  function stopScheduledSound() {
    if (!scheduledSoundSource) return;
    try { scheduledSoundSource.stop(); } catch (_) {}
    scheduledSoundSource = null;
  }

  function completeSession(options = {}) {
    timerRunning = false;
    timerHandle = null;
    lastTick = null;
    const completedTimerId = activeTimerId;
    activeTimerId = null;
    timerDeadline = null;
    postWorkerCancel();
    stopScheduledSound();

    const d = disciplineById(state.selectedDisciplineId);
    const t = state.tasks.find(x => x.id === state.selectedTaskId);
    const earnedMinutes = state.settings.focusMinutes;
    const earnedStars = earnedMinutes / 5;

    state.today.stars += earnedStars;
    state.today.sessions += 1;

    if (d?.id) {
      state.globalDisciplineStars[d.id] = Number(state.globalDisciplineStars[d.id] || 0) + earnedStars;
    }

    state.today.sessionsLog.push({
      id: makeId("session"),
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}),
      disciplineId: d?.id || null,
      taskId: t?.id || null,
      taskTitle: t?.title || "",
      minutes: earnedMinutes,
      stars: earnedStars
    });

    persist();

    if (state.settings.github?.owner && state.settings.github?.repo && state.settings.github?.token) {
      githubPutState().catch(() => {});
    }

    timerSeconds = state.settings.focusMinutes * 60;
    $("startPauseBtn").textContent = "Start";
    $("currentMode").textContent = "Ready";
    $("decreaseUnitsBtn").disabled = false;
    $("increaseUnitsBtn").disabled = false;
    $("completionNote").textContent = `+${earnedStars} ⭐ earned · ${earnedMinutes} minutes. Start the next Focus Unit manually when ready.`;
    $("completionNote").classList.add("good");

    $("completionTitle").textContent = `+${earnedStars} ⭐`;
    $("completionMessage").textContent =
      `${earnedMinutes} minutes complete. The next Focus Unit is manual — no auto-repeat.`;
    $("completionModal").classList.remove("hidden");

    // Notify through the Service Worker. This is the persistent notification path
    // that is intended to work outside the visible page UI.
    showCompletionNotification(earnedStars, completedTimerId);
    playCompletionSound();

    renderAll();
  }

  function updateTimerUI() {
    const total = Math.max(0, Math.ceil(timerSeconds));
    const min = Math.floor(total / 60);
    const sec = total % 60;

    $("timer").textContent = `${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
    $("focusUnitsCount").textContent = `${state.settings.focusMinutes} ${state.settings.focusMinutes === 1 ? "MINUTE" : "MINUTES"}`;
    $("focusUnitsMeta").textContent = `${formatStars(state.settings.focusMinutes / 5)} ⭐`;

    $("decreaseUnitsBtn").disabled = timerRunning || state.settings.focusMinutes <= 1;
    $("increaseUnitsBtn").disabled = timerRunning || state.settings.focusMinutes >= 60;
  }

  function renderResetCountdown() {
    const now = new Date();
    const reset = new Date(now);
    reset.setHours(state.settings.resetHour, 0, 0, 0);
    if (now >= reset) reset.setDate(reset.getDate() + 1);

    const diff = Math.max(0, reset - now);
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);

    $("resetCountdown").textContent =
      `Reset in ${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }

  function openSettings() {
    renderSettingsSummary();
    $("settingsModal").classList.remove("hidden");
  }

  function closeSettings() {
    $("settingsModal").classList.add("hidden");
  }

  function openRewardSettings() {
    renderRewardEditor();
    $("rewardModal").classList.remove("hidden");
  }

  function closeRewardSettings() {
    $("rewardModal").classList.add("hidden");
  }

  function saveRewardsAndClose() {
    applyRewardEditorInputs();
    persist();
    renderAll();
    closeRewardSettings();
    toast("Reward queue saved.");
  }

  function cancelRewards() {
    state = normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || JSON.stringify(state)));
    closeRewardSettings();
    renderAll();
  }

  function openDisciplineSettings() {
    renderDisciplineEditor();
    $("disciplineModal").classList.remove("hidden");
  }

  function closeDisciplineSettings() {
    applyDisciplineEditorInputs();
    persist();
    renderAll();
    $("disciplineModal").classList.add("hidden");
  }

  function saveSettings() {
    state.settings.theme = ["sky","paper","lavender"].includes($("themeInput").value)
      ? $("themeInput").value
      : "sky";
    state.settings.resetHour = clampInt($("resetHourInput").value, 0, 23);
    state.settings.focusStepMinutes = sanitizeFocusStep($("focusStepInput").value);

    persist();
    renderAll();
    closeSettings();
    toast("SWS settings saved.");
  }

  function resetToday() {
    if (!window.confirm("Reset today's SWS progress? Historical data will stay saved.")) return;

    state.history[state.today.date] = {
      stars: state.today.stars,
      sessions: state.today.sessions,
      sessionsLog: state.today.sessionsLog
    };
    state.today = {
      date: localDateKey(),
      stars: 0,
      sessions: 0,
      sessionsLog: []
    };

    persist();
    resetTimer();
    closeAllModals();
    renderAll();
    toast("Today's progress reset.");
  }

  function exportCSV() {
    const rows = [["Date","Stars","Minutes","Focus Units"]];
    const keys = new Set(Object.keys(state.history));
    keys.add(state.today.date);

    [...keys].sort().forEach(date => {
      const e = date === state.today.date ? state.today : state.history[date];
      rows.push([date, e.stars || 0, (e.stars || 0) * 5, e.sessions || 0]);
    });

    const csv = rows.map(row =>
      row.map(cell => `"${String(cell).replaceAll('"','""')}"`).join(",")
    ).join("\n");

    const blob = new Blob(["\ufeff" + csv], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sws-history-${localDateKey()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("CSV exported.");
  }


  function fillSyncForm() {
    const gh = state.settings.github || {};
    $("githubOwnerInput").value = gh.owner || "";
    $("githubRepoInput").value = gh.repo || "";
    $("githubBranchInput").value = gh.branch || "main";
    $("githubPathInput").value = gh.path || "data/sws-data.json";
    $("githubTokenInput").value = gh.token || "";
  }

  function readSyncForm() {
    state.settings.github = {
      owner: $("githubOwnerInput").value.trim(),
      repo: $("githubRepoInput").value.trim(),
      branch: $("githubBranchInput").value.trim() || "main",
      path: $("githubPathInput").value.trim() || "data/sws-data.json",
      token: $("githubTokenInput").value.trim()
    };
    persist();
    renderSettingsSummary();
  }

  function openSyncSettings() {
    fillSyncForm();
    $("syncStatus").textContent = state.settings.github?.owner && state.settings.github?.repo
      ? "Repository settings loaded. You can pull or push the current SWS state."
      : "Local data is the active source until you connect a repository.";
    $("syncModal").classList.remove("hidden");
  }

  function closeSyncSettings() {
    $("syncModal").classList.add("hidden");
  }

  function githubConfig(requireToken = true) {
    const gh = state.settings.github || {};
    if (!gh.owner || !gh.repo || !gh.branch || !gh.path) {
      throw new Error("Complete the GitHub repository settings first.");
    }
    if (requireToken && !gh.token) {
      throw new Error("Add a GitHub fine-grained token first.");
    }
    return gh;
  }

  function ghHeaders(token) {
    return {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    };
  }

  async function githubGetState() {
    const gh = githubConfig(true);
    const api = `https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/contents/${gh.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(gh.branch)}`;
    const res = await fetch(api, { headers: ghHeaders(gh.token) });
    if (!res.ok) throw new Error(`GitHub read failed (${res.status}).`);
    const payload = await res.json();
    if (!payload.content) throw new Error("The GitHub data file contains no readable content.");
    const binary = atob(payload.content.replace(/\n/g, ""));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    return { state: JSON.parse(decoded), sha: payload.sha };
  }

  function serializeForCloud() {
    const cloudState = structuredClone(state);
    if (cloudState.settings?.github) cloudState.settings.github.token = "";
    return JSON.stringify(cloudState, null, 2);
  }

  async function githubPutState() {
    const gh = githubConfig(true);
    let sha = null;

    try {
      const existing = await githubGetState();
      sha = existing.sha;
    } catch (e) {
      if (!String(e.message).includes("404")) throw e;
    }

    const bytes = new TextEncoder().encode(serializeForCloud());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const content = btoa(binary);

    const api = `https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/contents/${gh.path.split("/").map(encodeURIComponent).join("/")}`;
    const body = {
      message: `Update SWS data`,
      content,
      branch: gh.branch
    };
    if (sha) body.sha = sha;

    const res = await fetch(api, {
      method: "PUT",
      headers: ghHeaders(gh.token),
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const details = await res.text();
      throw new Error(`GitHub write failed (${res.status}): ${details.slice(0, 180)}`);
    }

    return await res.json();
  }

  async function pullFromGitHub() {
    try {
      readSyncForm();
      $("syncStatus").textContent = "Pulling SWS data from GitHub…";
      const result = await githubGetState();
      const keepToken = state.settings.github.token;
      state = normalizeState({ ...result.state, settings: { ...(result.state.settings || {}), github: { ...(result.state.settings?.github || {}), token: keepToken } } });
      persist();
      renderAll();
      $("syncStatus").textContent = "Pulled successfully. Local SWS now matches the GitHub file.";
      toast("SWS data pulled from GitHub.");
    } catch (e) {
      $("syncStatus").textContent = e.message;
      toast("GitHub pull failed.");
    }
  }

  async function pushToGitHub() {
    try {
      readSyncForm();
      $("syncStatus").textContent = "Saving SWS data to GitHub…";
      await githubPutState();
      $("syncStatus").textContent = "Saved successfully. Refreshing the GitHub Pages site will load this data after pull.";
      toast("SWS data saved to GitHub.");
    } catch (e) {
      $("syncStatus").textContent = e.message;
      toast("GitHub save failed.");
    }
  }

  function buildEmojiChoices() {
    const groups = [
      ["⭐","✨","🌟","💫","🔥","⚡","🚀","☄️","🌈","☀️","🌙","🌱","🍀","🌳","🌊","🌪️","🌋","❄️","☁️","🌸","🌼","🌻"],
      ["🎮","🕹️","💻","⌨️","🖱️","🧠","📚","📖","✏️","📝","🔬","🎨","🧊","🧩","🛠️","⚙️","🔧","🔨","📐","🖥️","📱"],
      ["🏋️","🏃","🚴","🤸","🧘","⚽","🏀","🎾","🥊","🥇","🏆","👑","💎","🏅","🎯","🧗","🚶","🧘‍♂️","🧘‍♀️"],
      ["💼","📈","💰","📊","📋","📬","📨","📣","🤝","🗂️","🗃️","📁","🧾","🪪","📝","🧑‍💻"],
      ["🎵","🎧","🎸","🎹","🎬","📺","🍿","🎥","🎭","🎨","🧸","🎲","🃏","♟️","🎻","🎷","🎺"],
      ["🍕","🍔","🍟","🍩","🍪","🍫","🍓","🍎","☕","🍵","🥤","🍜","🍣","🍰","🧁","🥐","🍉"],
      ["🐴","🐱","🐶","🦊","🐺","🐻","🐼","🐸","🐵","🐙","🦄","🐝","🦋","🐢","🐳","🦁","🐯","🐰"],
      ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","🩷","🩵","💖","💗","💓","💞","💝","💘"]
    ];
    const emojis = groups.flat();
    $("emojiGrid").innerHTML = emojis.map(emoji =>
      `<button type="button" class="emoji-choice" data-emoji="${escapeHtml(emoji)}" aria-label="${escapeHtml(emoji)}">${escapeHtml(emoji)}</button>`
    ).join("");

    document.querySelectorAll(".emoji-choice").forEach(btn =>
      btn.addEventListener("click", () => chooseEmoji(btn.dataset.emoji))
    );
  }

  let emojiTarget = null;
  function openEmojiPicker(target) { emojiTarget = target; buildEmojiChoices(); $("emojiModal").classList.remove("hidden"); }
  function closeEmojiPicker() { $("emojiModal").classList.add("hidden"); emojiTarget = null; }
  function chooseEmoji(emoji) {
    if (emojiTarget) {
      emojiTarget.textContent = emoji;
      emojiTarget.dispatchEvent(new Event("input", { bubbles: true }));
    }
    closeEmojiPicker();
  }

  function notificationsAreEnabled() {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (observedNotificationPermission === "granted") return true;
    return Boolean(state.settings.notificationsEnabled);
  }

  async function showTestNotification() {
    if (!notificationsAreEnabled()) return false;

    const title = "SWS notifications enabled";
    const options = {
      body: "You will be notified when a Focus Unit is complete.",
      icon: new URL("icon.png", window.location.href).href,
      tag: "sws-notification-test",
      renotify: false,
      data: { url: window.location.href }
    };

    try {
      if ("serviceWorker" in navigator) {
        const registration = notificationServiceWorkerRegistration || await navigator.serviceWorker.ready;
        notificationServiceWorkerRegistration = registration;
        await registration.showNotification(title, options);
        return true;
      }
    } catch (_) {}

    try {
      new Notification(title, options);
      return true;
    } catch (_) {
      return false;
    }
  }

  function renderNotificationState() {
    const card = $("notificationCard");
    const button = $("notificationBtn");
    const status = $("notificationStatus");
    card.classList.remove("notifications-enabled");

    if (typeof Notification === "undefined") {
      status.textContent = "This browser does not support desktop notifications.";
      button.textContent = "Unavailable";
      button.disabled = true;
      return;
    }

    if (!window.isSecureContext) {
      status.textContent = "Notifications require HTTPS or localhost. GitHub Pages supports them.";
      button.textContent = "HTTPS required";
      button.disabled = true;
      return;
    }

    if (Notification.permission === "granted" || observedNotificationPermission === "granted" || state.settings.notificationsEnabled) {
      status.textContent = notificationServiceWorkerRegistration
        ? "Notifications are enabled and ready for background completion alerts."
        : "Notifications are enabled. Preparing background notification service…";
      button.textContent = "Enabled ✓";
      button.disabled = true;
      card.classList.add("notifications-enabled");
    } else if (Notification.permission === "denied") {
      status.textContent = "Notifications are blocked by the browser. Re-enable them in site permissions.";
      button.textContent = "Blocked";
      button.disabled = true;
    } else {
      status.textContent = "Get a desktop notification when a Focus Unit is complete.";
      button.textContent = "Enable";
      button.disabled = false;
    }
  }

  async function requestNotificationPermission() {
    if (typeof Notification === "undefined" || !window.isSecureContext) {
      renderNotificationState();
      return;
    }

    try {
      if (Notification.permission === "granted") {
        state.settings.notificationsEnabled = true;
        persist();
        renderNotificationState();
        toast("Notifications are already enabled.");
        return;
      }

      const permission = await Notification.requestPermission();
      observedNotificationPermission = permission;
      state.settings.notificationsEnabled = permission === "granted";
      persist();
      renderNotificationState();
      setTimeout(renderNotificationState, 50);
      if (permission === "granted") {
        toast("Notifications enabled.");
        await showTestNotification();
      } else if (permission === "denied") {
        toast("Notifications were blocked by the browser.");
      }
    } catch (_) {
      toast("Could not request notifications.");
      renderNotificationState();
    }
  }

  async function showCompletionNotification(stars, timerId = null) {
    if (!notificationsAreEnabled()) return false;

    const title = "Focus Unit complete";
    const body = `+${formatStars(stars)} ⭐ earned. Start the next unit when ready.`;
    const options = {
      body,
      icon: new URL("icon.png", window.location.href).href,
      tag: "sws-focus-unit",
      renotify: true,
      requireInteraction: false,
      data: {
        url: window.location.href,
        timerId
      }
    };

    try {
      if (notificationServiceWorkerRegistration) {
        await notificationServiceWorkerRegistration.showNotification(title, options);
        return true;
      }

      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.ready;
        notificationServiceWorkerRegistration = registration;
        await registration.showNotification(title, options);
        return true;
      }
    } catch (_) {}

    // Fallback for browsers/pages where SW notification is unavailable.
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(title, options);
        return true;
      } catch (_) {}
    }

    return false;
  }

  function primeCompletionSound() {
    const audio = $("notificationSound");
    if (!audio) return;
    try {
      audio.muted = true;
      const p = audio.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
        }).catch(() => {
          audio.muted = false;
        });
      } else {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = false;
      }
    } catch (_) {}
  }

  function playCompletionSound() {
    const audio = $("notificationSound");
    if (audio) {
      try {
        audio.currentTime = 0;
        audio.volume = 1;
        const p = audio.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
        return;
      } catch (_) {}
    }
  }

  function closeAllModals() {
    $("settingsModal").classList.add("hidden");
    $("rewardModal").classList.add("hidden");
    $("disciplineModal").classList.add("hidden");
    $("syncModal").classList.add("hidden");
    $("emojiModal").classList.add("hidden");
    $("profileModal").classList.add("hidden");
    $("completionModal").classList.add("hidden");
  }

  function closeCompletion() {
    $("completionModal").classList.add("hidden");
    $("completionNote").classList.remove("good");
    $("completionNote").textContent = "Finish the focus unit to earn Stars. The next unit is always manual.";
  }

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function makeId(prefix) {
    if (window.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function formatStars(value) {
    const n = Number(value) || 0;
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(1).replace(/\.0$/, "");
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  $("startPauseBtn").addEventListener("click", toggleTimer);
  $("resetTimerBtn").addEventListener("click", resetTimer);
  $("decreaseUnitsBtn").addEventListener("click", () => changeFocusUnits(-1));
  $("increaseUnitsBtn").addEventListener("click", () => changeFocusUnits(1));

  $("addTaskBtn").addEventListener("click", addTask);
  $("taskInput").addEventListener("keydown", e => {
    if (e.key === "Enter") addTask();
  });
  $("taskDisciplineSelect").addEventListener("change", e => {
    state.selectedDisciplineId = e.target.value;
    state.selectedTaskId = null;
    persist();
    renderAll();
  });

  $("settingsBtn").addEventListener("click", openSettings);
  $("openRewardSettingsBtn").addEventListener("click", openRewardSettings);
  $("openDisciplineSettingsBtn").addEventListener("click", openDisciplineSettings);
  $("profileBtn").addEventListener("click", openProfile);
  $("closeProfileModalBtn").addEventListener("click", closeProfile);
  $("closeProfileDoneBtn").addEventListener("click", closeProfile);
  $("saveProfileBtn").addEventListener("click", saveProfile);
  $("chooseProfilePhotoBtn").addEventListener("click", () => $("profilePhotoInput").click());
  $("removeProfilePhotoBtn").addEventListener("click", removeProfilePhoto);
  $("profilePhotoInput").addEventListener("change", e => handleProfilePhoto(e.target.files?.[0]));
  $("profileModal").addEventListener("click", e => { if (e.target === $("profileModal")) closeProfile(); });

  $("closeSettingsBtn").addEventListener("click", closeSettings);
  $("settingsModal").addEventListener("click", e => {
    if (e.target === $("settingsModal")) closeSettings();
  });

  $("focusStepInput").addEventListener("change", () => {
    state.settings.focusStepMinutes = sanitizeFocusStep($("focusStepInput").value);
    persist();
  });
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("closeRewardModalBtn").addEventListener("click", closeRewardSettings);
  $("cancelRewardBtn").addEventListener("click", cancelRewards);
  $("saveRewardBtn").addEventListener("click", saveRewardsAndClose);
  $("rewardModal").addEventListener("click", e => {
    if (e.target === $("rewardModal")) closeRewardSettings();
  });
  $("addRewardBtn").addEventListener("click", addReward);
  $("newRewardEmoji").addEventListener("click", () => openEmojiPicker($("newRewardEmoji")));

  $("closeDisciplineModalBtn").addEventListener("click", closeDisciplineSettings);
  $("closeDisciplineDoneBtn").addEventListener("click", closeDisciplineSettings);
  $("disciplineModal").addEventListener("click", e => {
    if (e.target === $("disciplineModal")) closeDisciplineSettings();
  });
  $("addDisciplineBtn").addEventListener("click", addDiscipline);
  $("newDisciplineEmoji").addEventListener("click", () => openEmojiPicker($("newDisciplineEmoji")));

  $("openSyncSettingsBtn").addEventListener("click", openSyncSettings);
  $("closeSyncModalBtn").addEventListener("click", closeSyncSettings);
  $("syncModal").addEventListener("click", e => {
    if (e.target === $("syncModal")) closeSyncSettings();
  });
  $("saveSyncSettingsBtn").addEventListener("click", () => {
    readSyncForm();
    closeSyncSettings();
    toast("GitHub settings saved.");
  });
  $("clearSyncBtn").addEventListener("click", () => {
    state.settings.github = { owner: "", repo: "", branch: "main", path: "data/sws-data.json", token: "" };
    persist();
    fillSyncForm();
    renderSettingsSummary();
    $("syncStatus").textContent = "GitHub settings cleared.";
  });
  $("githubPullBtn").addEventListener("click", pullFromGitHub);
  $("githubPushBtn").addEventListener("click", pushToGitHub);

  $("closeEmojiModalBtn").addEventListener("click", closeEmojiPicker);
  $("emojiModal").addEventListener("click", e => {
    if (e.target === $("emojiModal")) closeEmojiPicker();
  });

  $("notificationBtn").addEventListener("click", requestNotificationPermission);
  $("resetTodayBtn").addEventListener("click", resetToday);
  $("exportBtn").addEventListener("click", exportCSV);
  document.querySelectorAll("[data-history-view]").forEach(btn => btn.addEventListener("click", () => {
    historyView = btn.dataset.historyView;
    localStorage.setItem("sws_history_view", historyView);
    renderHistory();
  }));

  $("closeCompletionBtn").addEventListener("click", closeCompletion);
  $("completionModal").addEventListener("click", e => {
    if (e.target === $("completionModal")) closeCompletion();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    ensureDay();

    if (timerRunning && timerDeadline && Date.now() >= timerDeadline) {
      completeSession({ fromVisibilityReconcile: true });
    } else if (!timerRunning) {
      updateTimerUI();
    }

    renderNotificationState();
  });

  document.addEventListener("keydown", e => {
    const tag = document.activeElement?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

    if (e.code === "Space" && !typing) {
      e.preventDefault();
      toggleTimer();
    }

    if (e.key.toLowerCase() === "r" && !typing) {
      resetTimer();
    }

    if (e.key === "Escape") {
      closeAllModals();
    }
  });

  setInterval(() => {
    ensureDay();
    renderResetCountdown();
    renderProgress();
    renderRewards();
  }, 1000);

  renderAll();
  renderResetCountdown();
})();
