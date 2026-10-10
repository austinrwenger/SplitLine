import { formatTime, formatGoalTime, formatPaceDelta, parseGoalTime, parseRoster, parseRosterImport, rosterText, parseCheckpoints, ordered, runNumber, timingOrder, selectSplits, paceComparison, leaderboard, resultsCSV, cleanConfig, parseInvite } from './core.mjs';
import configuredBackend from './firebase-config.mjs';

const KEY = 'splitline-store-v1';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const hex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), x => x.toString(16).padStart(2, '0')).join('');
let store;
let storageFailed = false;
try { store = JSON.parse(localStorage.getItem(KEY)); } catch { storageFailed = true; }
store ||= { version:1, deviceId:hex(16), coachName:'', config:null, sessions:{}, rosters:{}, active:null };
store.rosters ||= {};
let backend = null, backendStatus = 'unconfigured', backendError = '', liveOnline = false;
let unsubscribe = null, stopConnection = null, flight = false, clock = null, wakeLock = null;
let view = 'timing', search = '', resultCheckpoint = '', toastTimer = null, busy = false;
let pendingStart = null, pendingReset = null;
const session = () => store.sessions[store.active];
const practice = () => session()?.mode === 'practice';
const uid = () => practice() ? store.deviceId : backend?.uid || session()?.uid;
const isOwner = () => session()?.room?.owner === uid();
const hasConfig = () => !!(store.config || configuredBackend);
const online = () => practice() || (backend?.online && liveOnline);
const pendingCount = () => Object.keys(session()?.pending || {}).length;
const errorCount = () => Object.values(session()?.pending || {}).filter(x => x.error).length;

function commit(update) {
  const next = structuredClone(store);
  update(next);
  try { localStorage.setItem(KEY, JSON.stringify(next)); }
  catch { storageFailed = true; throw new Error('This phone cannot save data. Free browser storage and export a backup before timing.'); }
  store = next;
  storageFailed = false;
}
function saveSession(update) { const id = store.active; commit(next => update(next.sessions[id])); }
function archiveOldPending(current, newRoom) {
  if (runNumber(current.room) === runNumber(newRoom)) return 0;
  let count = 0;
  current.archivedPending ||= {};
  for (const [key, item] of Object.entries(current.pending || {})) {
    if ((item.run || item.data.run || 1) === runNumber(newRoom)) continue;
    current.archivedPending[key] = item;
    delete current.pending[key];
    count++;
  }
  return count;
}
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible'); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4200); }
function formError(error) { const target = $('#formError'); if (target) { target.textContent = friendly(error); target.classList.remove('hidden'); } else toast(friendly(error)); }
function friendly(error) {
  const code = String(error?.code || '');
  if (/permission.denied|PERMISSION_DENIED/.test(code + error?.message)) return 'Access was denied. Check the coach invite and the Firebase database rules.';
  if (/operation-not-allowed/.test(code)) return 'Enable Anonymous sign-in in Firebase Authentication first.';
  if (/network-request-failed/.test(code)) return 'Cannot connect right now. Check phone service and try again.';
  return error?.message || String(error);
}
function openModal(title, description, body) {
  $('#modal').innerHTML = `<div class="modal-inner"><div class="modal-head"><div><h2>${esc(title)}</h2><p>${esc(description)}</p></div><button class="close-button" data-action="close" aria-label="Close dialog">×</button></div>${body}<div id="formError" class="form-error hidden" role="alert"></div></div>`;
  $('#modal').showModal();
}
function closeModal() { $('#modal').close(); }
function actions(primaryLabel, primaryAction) { return `<div class="modal-actions"><button type="button" class="button" data-action="close">Cancel</button><button class="button primary" data-action="${primaryAction}">${primaryLabel}</button></div>`; }
function pill() {
  if (practice()) return '<span class="pill warn">Practice · this phone</span>';
  if (!hasConfig()) return '<span class="pill warn">Setup needed</span>';
  if (backendStatus === 'connecting') return '<span class="pill">Connecting</span>';
  if (backendStatus === 'error') return '<span class="pill danger">Not connected</span>';
  return online() ? '<span class="pill online">Connected</span>' : '<span class="pill warn">Offline</span>';
}
function header() { return `<header class="topbar"><a class="brand" href="#" data-action="home"><img src="./icon.svg" alt="">Split<span>Line</span></a><div class="top-actions">${pill()}<button class="icon-button" data-action="help" aria-label="Help and setup">?</button></div></header>`; }
function render() {
  const focused = document.activeElement;
  const focusId = focused?.id;
  const position = focused?.selectionStart;
  $('#app').innerHTML = header() + (session() ? raceMarkup() : homeMarkup());
  if (focusId && focused?.tagName === 'INPUT') { const field = document.getElementById(focusId); if (field) { field.focus(); if (typeof position === 'number') field.setSelectionRange(position, position); } }
  updateClock();
}
function homeMarkup() {
  const recent = Object.entries(store.sessions).sort((a,b) => b[1].createdAt - a[1].createdAt).slice(0,5);
  return `<main class="wrap"><div class="home-grid"><section class="hero"><div class="eyebrow">THE WHOLE CREW. ONE CLOCK.</div><h1>Every athlete.<br>Every split.<br>Together.</h1><p>Race timing that connects your coaches, from the starting line to the finish.</p><div class="hero-note">↗ Built for the sideline, not a spreadsheet.</div><div class="course-lines"></div></section><section><div class="card"><div class="card-head"><h2>Meet your race day.</h2><span class="eyebrow muted">01 / GET STARTED</span></div><p class="muted small">One coach starts the race. Your crew takes it from there.</p><div class="stack"><button class="button dark" data-action="create">＋ Create a race</button><button class="button" data-action="join">↗ Join a coach’s race</button><button class="link-button" data-action="practice">Try single-phone practice →</button></div><div class="feature-row"><div class="feature-icon">◷</div><div><strong>One shared race start</strong><span>No separate stopwatch starts to coordinate.</span></div></div><div class="feature-row"><div class="feature-icon">↥</div><div><strong>Splits saved before upload</strong><span>Record through a gap in phone service.</span></div></div><div class="feature-row"><div class="feature-icon">≋</div><div><strong>The whole race, in view</strong><span>Checkpoint rankings and cumulative splits.</span></div></div></div><div class="card connection-card ${backendStatus === 'ready' ? 'ready' : ''}"><h3>${backendStatus === 'ready' ? 'Shared backend connected' : 'Live sharing needs a one-time setup'}</h3><p>${backendStatus === 'ready' ? 'Ready to create a race and invite your coaches.' : 'Practice works now. Shared races need your Firebase project connected before any real multi-phone timing.'}</p>${backendError ? `<p>${esc(backendError)}</p>` : ''}<button class="link-button" data-action="setup">${hasConfig() ? 'Connection settings' : 'Set up live sharing'} →</button></div>${recent.length ? `<div class="card"><h2>Saved on this phone</h2><div class="recent-list">${recent.map(([id,s]) => `<button class="button recent-item" data-action="resume" data-id="${id}"><span>${esc(s.room.meta.name)}<small class="muted" style="display:block">${s.mode === 'practice' ? 'Practice' : 'Shared race'} · ${Object.keys(s.pending || {}).length} pending</small></span><span>→</span></button>`).join('')}</div></div>` : ''}</section></div><p class="bottom-note" style="margin-top:24px">Coaching-grade manual timing, not certified competition results. Use initials or bibs if preferred. Coach invites are private access links.</p></main>`;
}
function raceMarkup() {
  const s = session(), room = s.room;
  const cps = ordered(room.checkpoints), cells = selectSplits(room,s.pending);
  if (!s.checkpoint || !room.checkpoints[s.checkpoint]) s.checkpoint = cps[0][0];
  if (!resultCheckpoint || !room.checkpoints[resultCheckpoint]) resultCheckpoint = s.checkpoint;
  const n = pendingCount(), errors = errorCount();
  const finished = Object.keys(room.athletes).filter(id => cells[`${id}:${cps.at(-1)[0]}`]).length;
  let notice = '';
  if (practice()) notice += '<div class="notice">Single-phone practice. Nothing here is shared with other devices. Use this mode to try the controls.</div>';
  else if (!online()) notice += `<div class="notice">Offline: this phone can keep recording a race whose start it already received. Other coaches’ new splits will appear after reconnecting.${n ? ` ${n} tap${n===1?'':'s'} waiting to upload.` : ''}</div>`;
  if (errors) notice += `<div class="notice danger">${errors} upload${errors===1?'':'s'} failed. They remain saved on this phone. <button class="link-button" data-action="retry">Retry uploads</button> · <button class="link-button" data-action="backup">Download backup</button></div>`;
  if (Object.keys(s.archivedPending || {}).length) notice += `<div class="notice">Splits saved on this phone from an earlier start are excluded from this attempt. <button class="link-button" data-action="backup">Download raw backup</button></div>`;
  if (storageFailed) notice += '<div class="notice danger">Phone storage is not working. Do not record until resolved. Export a backup.</div>';
  if (s.uid && backend && s.mode === 'live' && backend.uid !== s.uid && n) notice += '<div class="notice danger">Your browser’s coach identity changed. Old pending taps cannot upload under the new identity. Export a backup for manual recovery.</div>';
  const content = view === 'timing' ? timingMarkup(cells) : view === 'results' ? resultsMarkup() : crewMarkup();
  const status = pendingReset ? 'Resetting false start…' : pendingStart ? 'Confirming shared start…' : room.state.status === 'ready' ? 'Waiting to start' : room.state.status === 'finished' ? 'Race ended' : 'Race in progress';
  return `<main class="wrap"><div class="race-title"><div><h1>${esc(room.meta.name)}</h1><p>${Object.keys(room.athletes).length} athletes · ${cps.length} checkpoints · Attempt ${runNumber(room)} · ${esc(store.coachName || 'Coach')}</p></div><div class="race-actions">${isOwner()&&room.state.status!=='finished'?`<button class="button small" data-action="add-athlete" ${busy||!online()?'disabled':''}>＋ Add athlete</button>`:''}<button class="button small" data-action="invite">↗ Invite crew</button></div></div>${notice}<div class="race-grid"><section><div class="clock-card"><div class="clock-head"><span class="eyebrow">RACE CLOCK</span><span class="pill">${status}</span></div><div class="race-clock" id="raceClock">00:00.0</div><div class="clock-caption" id="clockCaption">Everyone runs from the same start.</div>${clockActions()}<div class="clock-quality"><span>${clockLabel()}</span>${room.state.status === 'ready' && !practice() ? '<button data-action="calibrate">Sync clock</button>' : '<span>Manual timing</span>'}</div></div><nav class="tabs" aria-label="Race views">${[['timing','◷ Timing'],['results','≋ Results'],['crew','◎ Crew']].map(([v,label])=>`<button class="tab ${view===v?'active':''}" data-action="view" data-view="${v}" aria-current="${view===v?'page':'false'}">${label}</button>`).join('')}</nav>${content}</section><aside class="race-aside"><div class="card activity-card"><div class="card-head"><h2>Latest splits</h2><span class="eyebrow muted">CREW FEED</span></div>${activityMarkup(8)}<div class="queue-line"><span>${n ? `${n} pending on this phone` : practice() ? 'Stored on this phone' : 'No pending uploads'}</span><button class="link-button" data-action="export">Export</button></div></div><p class="bottom-note">Timing is taken at the tap—not when the upload arrives. The server clock is an estimate; phone latency and human reaction affect accuracy.</p><button class="link-button" data-action="home">← Leave race view</button></aside></div><div class="sticky-mobile"><span>${n ? `${n} pending · saved here` : practice() ? 'Practice · saved here' : online() ? 'Connected · no pending uploads' : 'Offline · saved here'}</span><button class="button small" data-action="last-undo" ${canUndoLast() ? '' : 'disabled'}>↶ Undo last tap</button></div></main>`;
}
function clockLabel() {
  if (practice()) return 'Local practice clock';
  if (!clock && !session()?.clock) return 'Clock not synchronized';
  const rtt = clock?.rtt ?? session()?.clock?.rtt;
  return `${clock ? 'Clock estimate synced' : 'Cached clock estimate'}${Number.isFinite(rtt) ? ` · ${Math.round(rtt)} ms round trip` : ''}`;
}
function clockActions() {
  const state = session().room.state;
  if (pendingStart) return '<div class="clock-action"><span class="small">Clock started on this phone · confirming for the crew…</span></div>';
  if (pendingReset) return '<div class="clock-action"><span class="small">Resetting for the crew…</span></div>';
  if (state.status === 'ready') {
    if (!isOwner()) return '<div class="clock-action"><span class="small muted" style="color:#b5c3d0">The starter will start the shared race. Stay connected until the start appears.</span></div>';
    const needsSync = !practice() && (!clock || Date.now() - clock.calibratedAt > 300000);
    return `<div class="clock-action"><button class="button primary" data-action="start" ${busy || !online() || needsSync ? 'disabled' : ''}>▶ Start at the gun</button>${needsSync ? '<span class="small">Sync clock before the gun.</span>' : ''}</div>`;
  }
  return `<div class="clock-action">${isOwner() && state.status === 'running' ? '<button class="button soft" data-action="finish">End race</button><button class="button soft" data-action="false-start">False start · reset</button>' : ''}<button class="button soft" data-action="export">↓ Export results</button></div>`;
}
function checkpointSelect(selected, id, label) {
  return `<div class="checkpoint-select"><label for="${id}">${label}</label><select id="${id}">${ordered(session().room.checkpoints).map(([cpid,cp])=>`<option value="${cpid}" ${selected===cpid?'selected':''}>${esc(cp.label)}${cp.finish?' · FINISH':''}</option>`).join('')}</select></div>`;
}
function paceBadge(pace) {
  if (!pace) return '<span class="pace-none">—</span>';
  const fast = pace.deltaMs >= 0;
  return `<span class="pace-delta ${fast?'fast':'slow'}">${formatPaceDelta(pace.deltaMs)}<small>${fast?'ahead':'behind'}</small></span>`;
}
function timingMarkup(cells) {
  const s=session(), room=s.room, cp=s.checkpoint;
  const athletes=timingOrder(room,cp,s.pending).filter(([,a]) => `${a.name} ${a.bib}`.toLowerCase().includes(search.toLowerCase()));
  const recorded = Object.keys(room.athletes).filter(id=>cells[`${id}:${cp}`]).length;
  return `${checkpointSelect(cp,'checkpoint','MY CHECKPOINT')}<div class="section-head"><h2>Tap as they pass.</h2><span class="small">${recorded} / ${Object.keys(room.athletes).length} recorded</span></div><input class="search" id="athleteSearch" type="search" autocomplete="off" value="${esc(search)}" placeholder="Find athlete or bib…" aria-label="Find athlete or bib"><div class="athlete-grid">${athletes.map(([id,a])=>{
    const split=cells[`${id}:${cp}`];
    const disabled=!split && (room.state.status !== 'running' || !room.state.startedAt || storageFailed || busy);
    return `<button class="athlete-button ${split?'done':''} ${split?.pending?'pending':''} ${split?.failed?'failed':''}" data-action="tap" data-id="${id}" ${disabled?'disabled':''}><span class="bib">BIB ${esc(a.bib)}</span><span class="athlete-name">${esc(a.name)}</span><span class="tap-icon">${split?'✓':'＋'}</span>${split?`<span class="athlete-time">${formatTime(split.elapsedMs)}</span>`:''}<span class="athlete-hint">${split ? split.failed ? 'Upload failed · saved here' : split.pending ? 'Pending upload · saved here' : split.alternatives.length ? 'Multiple taps · review' : practice() ? 'Saved here · tap to review' : 'Synced · tap to review' : 'Tap to record split'}</span></button>`;
  }).join('')}</div>${athletes.length ? '' : '<div class="empty">No matching athletes.</div>'}<p class="bottom-note" style="margin-top:14px">Athletes follow their latest checkpoint order. Recorded athletes move below those still waiting. Choose your checkpoint before timing.</p>`;
}
function resultsMarkup() {
  const s=session(), room=s.room, rows=leaderboard(room,resultCheckpoint,s.pending);
  const cps=ordered(room.checkpoints), finish=cps.at(-1)[0], cells=selectSplits(room,s.pending);
  const total=Object.keys(room.athletes).length, completed=Object.keys(room.athletes).filter(id=>cells[`${id}:${finish}`]).length;
  return `<div class="finish-summary"><strong>${completed}/${total}</strong><span>athletes recorded at the finish<br>${practice() ? 'Local practice results' : 'Shared results update while connected'} · <b class="fast-key">green + is ahead</b> · <b class="slow-key">red − is behind</b></span></div>${checkpointSelect(resultCheckpoint,'resultCheckpoint','RANK AT')}<div class="table-wrap"><table class="results-table"><thead><tr><th>POS</th><th>ATHLETE</th><th>ELAPSED</th><th>VS GOAL</th><th>LEG</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r.rank?`<span class="rank ${r.rank===1?'first':''}">${r.rank}</span>`:'—'}</td><td class="result-name">${esc(r.name)}<small>Bib ${esc(r.bib)}${r.goalMs?` · Goal ${formatGoalTime(r.goalMs)}`:''}</small></td><td><span class="result-time">${r.split?formatTime(r.split.elapsedMs):'—'}</span>${r.split?.failed?'<span class="result-tag conflict">UPLOAD FAILED</span>':r.split?.pending?'<span class="result-tag">PENDING</span>':''}${r.split?.alternatives.length?'<span class="result-tag conflict">MULTIPLE TAPS</span>':''}</td><td>${r.split?paceBadge(r.pace):'—'}</td><td>${r.backwards?'<span class="result-tag conflict">CHECK ORDER</span>':r.legMs===null?'—':formatTime(r.legMs)}</td></tr>`).join('')}</tbody></table></div><p class="bottom-note" style="margin-top:14px">Vs goal compares the live cumulative split with the athlete’s goal finish time, scaled to this checkpoint’s distance. Ranked only against athletes recorded at this same checkpoint.</p><div class="card" style="margin-top:18px"><h2>All athlete splits</h2><div class="table-wrap"><table class="results-table"><thead><tr><th>ATHLETE</th>${cps.map(([,cp])=>`<th>${esc(cp.label)}</th>`).join('')}</tr></thead><tbody>${ordered(room.athletes).map(([id,a])=>`<tr><td class="result-name">${esc(a.name)}<small>Bib ${esc(a.bib)}${a.goalMs?` · Goal ${formatGoalTime(a.goalMs)}`:''}</small></td>${cps.map(([cp])=>{const split=cells[`${id}:${cp}`],pace=split?paceComparison(room,id,cp,split.elapsedMs):null;return `<td>${split?formatTime(split.elapsedMs):'—'}${pace?paceBadge(pace):''}${split?.pending?'<span class="result-tag">PENDING</span>':''}</td>`}).join('')}</tr>`).join('')}</tbody></table></div></div><div class="stack"><button class="button" data-action="export">↓ Download results CSV</button><button class="link-button" data-action="backup">Download raw backup (includes pending taps)</button></div>`;
}
function crewMarkup() {
  const s=session(), room=s.room;
  const members=Object.entries(room.members || {});
  return `<div class="card"><div class="card-head"><h2>Your timing crew</h2><button class="button small" data-action="invite">Invite</button></div>${members.map(([id,member])=>{const p=room.presence?.[id];const cp=room.checkpoints[p?.checkpointId];return `<div class="crew-item"><div class="avatar">${esc(member.name.slice(0,2).toUpperCase())}</div><div class="crew-info">${esc(member.name)}${id===room.owner?' · starter':''}${id===uid()?' · you':''}<small>${esc(cp?.label || 'Checkpoint not selected')}${p?.clockReady?' · clock synced':''}</small></div><span class="pill ${p?.online?'online':'warn'}">${p?.online?'Online':'Offline'}</span></div>`}).join('')}<p class="bottom-note" style="margin-top:14px">Make sure every coach has joined, selected a checkpoint, and synchronized their clock before starting. Offline coaches cannot receive the start until they reconnect.</p></div><div class="card"><h2>Recent race activity</h2>${activityMarkup(30)}</div><button class="button" data-action="home">← Leave race view</button>`;
}
function allEffectiveEvents() {
  const s=session(); if (!s) return [];
  const events={...(s.room.events||{})}, voids={...(s.room.voids||{})};
  for(const item of Object.values(s.pending||{})) (item.kind==='event'?events:voids)[item.id]=item.data;
  return Object.entries(events).filter(([id,e])=>!voids[id] && (e.run || 1)===runNumber(s.room)).map(([id,e])=>({...e,id,pending:!!s.pending['event:'+id]})).sort((a,b)=>b.capturedAt-a.capturedAt || b.id.localeCompare(a.id));
}
function canUndoLast() { return allEffectiveEvents().some(e=>e.coachId===uid()); }
function activityMarkup(max) {
  const room=session().room, events=allEffectiveEvents().slice(0,max);
  if(!events.length) return '<div class="empty">The first tap starts your feed.<br>Splits from your crew appear here.</div>';
  return `<div class="activity-list">${events.map(e=>`<div class="activity-item"><div class="activity-info"><strong>${esc(room.athletes[e.athleteId]?.name || 'Athlete')}</strong><small>${esc(room.checkpoints[e.checkpointId]?.label)} · ${esc(e.coachName)}${e.pending?' · pending':''}</small>${e.coachId===uid()||isOwner()?`<button class="undo-button" data-action="undo" data-id="${e.id}">Undo this split</button>`:''}</div><span class="activity-time">${formatTime(e.elapsedMs)}</span></div>`).join('')}</div>`;
}
function timeNow() {
  if(practice()) return Date.now();
  if(clock) {
    // Some mobile systems suspend performance.now in sleep. Detect and use the
    // cached wall-clock offset if the clocks diverge; label subsequent taps cached.
    const wall = Date.now() + clock.offset;
    const monotonic = clock.anchor + performance.now();
    if(Math.abs(wall-monotonic)>1000) { clock=null; return wall; }
    return monotonic;
  }
  return Date.now() + (session()?.clock?.offset || 0);
}
function updateClock() {
  const s=session(), display=$('#raceClock'); if(!s || !display) return;
  const state=pendingReset ? {status:'ready',startedAt:0,endedAt:0} : pendingStart ? {status:'running',startedAt:pendingStart.startedAt,endedAt:0} : s.room.state;
  const now=timeNow();
  const elapsed=state.status==='ready'?0:(state.status==='finished'?state.endedAt:now)-state.startedAt;
  display.textContent=formatTime(Math.max(0,elapsed));
  const caption=$('#clockCaption');
  caption.textContent=pendingStart?'Clock started at your tap. Confirming the start online…':pendingReset?'Waiting for the reset to reach your crew…':state.status==='ready'?'Tap Start at the gun; there is no countdown.':state.status==='finished'?'Race ended. Late uploads can still arrive.':'Tap an athlete at your selected checkpoint.';
}
async function ensureBackend() {
  if(backend) return backend;
  if(!hasConfig()) throw new Error('Connect Firebase first, or use single-phone practice.');
  backendStatus='connecting'; backendError=''; render();
  try {
    const { connectBackend }=await import('./backend.mjs');
    backend=await connectBackend(cleanConfig(store.config||configuredBackend));
    backendStatus='ready';
    stopConnection=backend.onConnection(value=>{
      liveOnline=value;
      render();
      if(value && session()?.mode==='live') { updatePresence(); flushQueue(); }
    });
    if(session()?.room.state.status !== 'running') await calibrateClock();
    render(); return backend;
  } catch(error) { backendStatus='error'; backendError=friendly(error); render(); throw error; }
}
async function calibrateClock() {
  if(!backend || !backend.online) throw new Error('Connect this phone before synchronizing its clock.');
  if(session()?.room.state.status==='running') throw new Error('The clock is pinned during the race; synchronize before starting.');
  const sample=await backend.calibrate();
  clock={...sample,offset:sample.anchor+performance.now()-Date.now()};
  if(session()?.mode==='live') saveSession(s=>{s.clock={offset:clock.offset,rtt:clock.rtt,calibratedAt:clock.calibratedAt};});
  await updatePresence();
  render();
}
async function attachSession() {
  unsubscribe?.(); unsubscribe=null;
  pendingStart=null; pendingReset=null;
  const s=session(); if(!s) return;
  view='timing'; search=''; resultCheckpoint=s.checkpoint;
  if(s.mode==='practice') { render(); return; }
  // Resume cached recording even if the CDN or service is unavailable.
  render();
  try {
    await ensureBackend();
    const id=store.active;
    if(backend.uid!==s.uid && Object.keys(s.pending||{}).length) toast('Coach identity changed. Export pending taps for recovery.');
    const remote=await backend.join(id,s.token,store.coachName||'Coach');
    saveSession(current=>{archiveOldPending(current,remote);current.room=remote;current.uid=backend.uid;});
    unsubscribe=backend.subscribe(id,room=>{
      if(store.active!==id || !room) return;
      try { let archived=0; saveSession(current=>{archived=archiveOldPending(current,room);current.room=room;});render();if(archived)toast(`${archived} old tap${archived===1?'':'s'} kept in the raw backup after the false start.`); } catch(error) { toast(friendly(error)); }
    },error=>{backendError=friendly(error);toast(backendError);});
    await updatePresence();
    await requestWakeLock();
    flushQueue();
  } catch(error) { toast(friendly(error)); render(); }
}
async function updatePresence() {
  const s=session(); if(!s || s.mode!=='live' || !backend?.online) return;
  try { await backend.presence(store.active,{name:store.coachName||'Coach',checkpointId:s.checkpoint,clockReady:!!(clock||s.clock)}); } catch(error) { toast(friendly(error)); }
}
async function requestWakeLock() {
  try { if('wakeLock' in navigator && document.visibilityState==='visible' && session()) wakeLock=await navigator.wakeLock.request('screen'); } catch { /* OS may decline; timing still uses timestamps. */ }
}
async function flushQueue() {
  const s=session(); if(flight || !s || s.mode==='practice' || !backend?.online) return;
  const id=store.active;
  flight=true;
  try {
    for(const item of Object.values(s.pending||{})) {
      if(!backend.online || store.active!==id) break;
      if(item.error) continue;
      const queueKey=item.kind+':'+item.id;
      if(!store.sessions[id].pending[queueKey]) continue;
      if((item.run || item.data.run || 1)!==runNumber(store.sessions[id].room)) {
        commit(next=>{const current=next.sessions[id];current.archivedPending||={};current.archivedPending[queueKey]=item;delete current.pending[queueKey];});
        render();continue;
      }
      if(item.data.coachId!==backend.uid) { commit(next=>{next.sessions[id].pending[queueKey].error='Coach identity changed';});render();continue; }
      try {
        await backend.send(id,item);
        commit(next=>{const current=next.sessions[id];if(!current.pending[queueKey])return;(item.kind==='event'?(current.room.events||={}):(current.room.voids||={}))[item.id]=item.data;delete current.pending[queueKey];});
      } catch(error) { commit(next=>{if(next.sessions[id].pending[queueKey]) next.sessions[id].pending[queueKey].error=friendly(error);}); }
      render();
    }
  } finally { flight=false; }
}
function enqueue(kind,id,data) {
  saveSession(s=>{
    if(s.mode==='practice') { (kind==='event'?(s.room.events||={}):(s.room.voids||={}))[id]=data; }
    else s.pending[kind+':'+id]={kind,id,data,run:runNumber(s.room)};
  });
  render(); flushQueue();
}
function recordTap(athleteId) {
  const capturedAt=Math.round(timeNow()); // Take timestamp BEFORE UI, storage, or network work.
  if(busy || pendingStart || pendingReset) return;
  const s=session(); if(!s) return;
  const existing=selectSplits(s.room,s.pending)[`${athleteId}:${s.checkpoint}`];
  if(existing) return splitDetails(athleteId,existing);
  if(s.room.state.status!=='running' || capturedAt<s.room.state.startedAt) return toast('Wait for the shared start.');
  if(s.mode==='live'&&!s.clock&&!clock) return toast('Synchronize your phone’s clock before recording.');
  const event={athleteId,checkpointId:s.checkpoint,elapsedMs:Math.max(0,capturedAt-s.room.state.startedAt),capturedAt,coachId:uid(),coachName:store.coachName||'Coach',clockQuality:practice()?'local':clock&&online()?'synced':'cached'};
  if(runNumber(s.room)>1)event.run=runNumber(s.room);
  enqueue('event',hex(16),event);
  navigator.vibrate?.(30);
  toast(`${s.room.athletes[athleteId].name} · ${formatTime(event.elapsedMs)} · ${practice()?'saved here':online()?'uploading':'saved, waiting to upload'}`);
}
function splitDetails(athleteId,split) {
  const room=session().room;
  openModal(`${room.athletes[athleteId].name} · ${room.checkpoints[session().checkpoint].label}`,'Review recorded taps. Undo a mistaken tap before recording again.',`<div class="split-details">${[split,...split.alternatives].map(e=>`<div class="split-detail"><strong>${formatTime(e.elapsedMs)}</strong><p>${esc(e.coachName)} · ${e.failed?'upload failed':e.pending?'pending upload':practice()?'local practice':'synced'} · ${esc(e.clockQuality)} clock</p>${e.coachId===uid()||isOwner()?`<button class="button small danger" data-action="undo" data-id="${e.id}">Undo this split</button>`:''}</div>`).join('')}</div><button class="button" data-action="close">Done</button>`);
}
function undo(id) {
  const event=allEffectiveEvents().find(e=>e.id===id);
  if(!event || (event.coachId!==uid()&&!isOwner())) return toast('Only the recording coach or starter can undo this split.');
  enqueue('void',id,{coachId:uid(),at:Math.round(timeNow())});
  closeModal(); toast('Split undone. You can record that athlete again.');
}
function createDialog(mode='live') {
  if(mode==='live'&&!hasConfig()) { setupDialog();return; }
  const saved=Object.entries(store.rosters).sort((a,b)=>b[1].savedAt-a[1].savedAt);
  const [selectedId,selected]=saved[0]||[];
  const initial=selected?rosterText(selected.athletes):mode==='practice'?'12, Alex, 18:30\n24, Jordan, 19:00\n36, Sam, 19:30\n48, Casey, 20:00\n52, Taylor, 20:30\n67, Morgan, 21:00':'';
  const date=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric'}).format(new Date());
  openModal(mode==='practice'?'New practice race':'New shared race','Name the race, add goal finish times, and set checkpoint distances.',`<label class="field">Race name<input id="raceName" maxlength="60" value="${mode==='practice'?'Practice · ':''}Race · ${date}" autocomplete="off"></label><label class="field">Your coach name<input id="coachName" maxlength="40" value="${esc(store.coachName)}" placeholder="Coach name" autocomplete="name"></label><div class="roster-box"><h3>Race roster</h3><label class="field">Use a saved roster<select id="savedRoster"><option value="">Enter a new roster</option>${saved.map(([id,r])=>`<option value="${id}" ${id===selectedId?'selected':''}>${esc(r.name)} · ${Object.keys(r.athletes).length} athletes</option>`).join('')}</select></label><div class="roster-tools"><label class="button small upload-button">↑ Upload CSV or TXT<input id="rosterFile" type="file" accept=".csv,.txt,text/csv,text/plain"></label><span class="small muted">CSV columns can be Bib, Name, Goal Time.</span></div><label class="field">Athletes · one per line<textarea id="roster" rows="6" placeholder="12, Alex, 18:30\n24, Jordan, 19:00">${esc(initial)}</textarea><small>Bib, name, goal finish (optional) · use minutes:seconds. Saved rosters keep goal times for future races.</small></label><label class="field">Save this roster as<input id="rosterName" maxlength="60" value="${esc(selected?.name||'')}" placeholder="e.g. Varsity runners"></label><button class="button small" data-action="save-roster">Save roster for future races</button></div><label class="field" style="margin-top:18px">Checkpoints · name and distance<textarea id="checkpoints" rows="3">Mile 1, 1 mi\nMile 2, 2 mi\nFinish, 5 km</textarea><small>Use mi, km, m, or yd. The finish distance is the race distance used to calculate every goal split.</small></label>${actions(mode==='practice'?'Create practice race':'Create race',mode==='practice'?'save-practice':'save-race')}`);
}
function saveRosterFromForm() {
  const athletes=parseRoster($('#roster').value);
  const name=$('#rosterName').value.trim();
  if(!name || name.length>60) throw new Error('Name this roster before saving it.');
  const selected=$('#savedRoster').value;
  const id=store.rosters[selected]?selected:hex(8);
  commit(next=>{next.rosters||={};next.rosters[id]={name,athletes,savedAt:Date.now()};});
  const select=$('#savedRoster');
  select.innerHTML='<option value="">Enter a new roster</option>'+Object.entries(store.rosters).sort((a,b)=>b[1].savedAt-a[1].savedAt).map(([key,r])=>`<option value="${key}">${esc(r.name)} · ${Object.keys(r.athletes).length} athletes</option>`).join('');
  select.value=id;
  toast(`${name} saved for future races on this phone.`);
}
async function uploadRoster(file) {
  if(!file)return;
  if(file.size>100000)throw new Error('Choose a small roster file (under 100 KB).');
  const athletes=parseRosterImport(await file.text());
  const name=file.name.replace(/\.[^.]+$/,'').trim().slice(0,60)||'Imported roster';
  $('#savedRoster').value='';
  $('#roster').value=rosterText(athletes);
  $('#rosterName').value=name;
  saveRosterFromForm();
}
async function createRace(mode) {
  if(busy) return;
  const coachName=$('#coachName').value.trim()||'Coach';
  const name=$('#raceName').value.trim(); if(!name||name.length>60) throw new Error('Enter a race name under 60 characters.');
  const athletes=parseRoster($('#roster').value), checkpoints=parseCheckpoints($('#checkpoints').value);
  if(Object.values(athletes).some(a=>a.goalMs) && Object.values(checkpoints).some(cp=>!cp.distanceM)) throw new Error('Add a distance to every checkpoint to compare splits with goal times.');
  const id=hex(8), token=hex(16);
  busy=true;
  const button=$(`[data-action="${mode==='practice'?'save-practice':'save-race'}"]`);button.disabled=true;button.textContent='Creating…';
  try {
    if(mode==='live') await ensureBackend();
    const owner=mode==='practice'?store.deviceId:backend.uid;
    const initialState={status:'ready',startedAt:0,endedAt:0};
    if(mode==='practice')initialState.run=1;
    const room={owner,invite:token,meta:{name,createdAt:Math.round(timeNow())},athletes,checkpoints,state:initialState,members:{[owner]:{name:coachName,invite:token}},presence:mode==='practice'?{[owner]:{name:coachName,online:true,checkpointId:'c1',clockReady:true}}:{}};
    if(mode==='live') await backend.create(id,room);
    commit(next=>{next.coachName=coachName;next.active=id;next.sessions[id]={mode,uid:owner,token,room,checkpoint:'c1',pending:{},createdAt:Date.now(),clock:mode==='live'&&clock?{offset:clock.offset,rtt:clock.rtt,calibratedAt:clock.calibratedAt}:null};});
    closeModal();await attachSession();
  } finally { busy=false; if(button.isConnected){button.disabled=false;button.textContent='Create race';}render(); }
}
function addAthleteDialog() {
  const room=session()?.room;
  if(!room || !isOwner()) throw new Error('Only the starter can add athletes.');
  if(room.state.status==='finished') throw new Error('This race is finished. Create a new race to change its roster.');
  if(Object.keys(room.athletes).length>=20) throw new Error('This race already has the maximum of 20 athletes.');
  const hasDistances=ordered(room.checkpoints).every(([,cp])=>cp.distanceM);
  openModal('Add an athlete',room.state.status==='running'?'They will appear immediately for every connected checkpoint coach.':'Add them now or after the race starts.',`<label class="field">Bib or athlete number<input id="newAthleteBib" maxlength="12" autocomplete="off" inputmode="numeric" placeholder="e.g. 42"></label><label class="field">Athlete name<input id="newAthleteName" maxlength="60" autocomplete="off" placeholder="e.g. Jamie"></label><label class="field">Goal finish time · optional<input id="newAthleteGoal" autocomplete="off" inputmode="numeric" placeholder="e.g. 18:30"><small>${hasDistances?'The Results tab will calculate their goal split at every checkpoint.':'This older race has no checkpoint distances, so a goal can be saved but split comparisons will be unavailable.'}</small></label>${actions('Add athlete','confirm-add-athlete')}`);
}
async function addAthlete() {
  const room=session()?.room;
  if(!room || !isOwner()) throw new Error('Only the starter can add athletes.');
  if(!online()) throw new Error('Reconnect before adding an athlete to a shared race.');
  if(room.state.status==='finished') throw new Error('This race is already finished.');
  if(Object.keys(room.athletes).length>=20) throw new Error('This race already has the maximum of 20 athletes.');
  const bib=$('#newAthleteBib').value.trim(), name=$('#newAthleteName').value.trim(), goalText=$('#newAthleteGoal').value.trim();
  if(!bib||bib.length>12) throw new Error('Enter a bib or athlete number under 12 characters.');
  if(!name||name.length>60) throw new Error('Enter an athlete name under 60 characters.');
  if(Object.values(room.athletes).some(a=>a.bib.toLowerCase()===bib.toLowerCase())) throw new Error(`Bib ${bib} is already in this race.`);
  const goalMs=goalText?parseGoalTime(goalText):null;
  if(goalText&&!goalMs) throw new Error('Use minutes:seconds for the goal finish time, like 18:30.');
  const athleteId=Array.from({length:20},(_,i)=>`a${i+1}`).find(id=>!room.athletes[id]);
  if(!athleteId) throw new Error('No athlete slot is available.');
  const order=Math.max(-1,...Object.values(room.athletes).map(a=>a.order))+1;
  const athlete={bib,name,order,...(goalMs?{goalMs}:{})};
  const id=store.active;
  busy=true;const button=$('[data-action="confirm-add-athlete"]');button.disabled=true;button.textContent='Adding…';
  try {
    const saved=practice()?athlete:await backend.addAthlete(id,athleteId,athlete);
    if(store.active===id)saveSession(s=>{s.room.athletes[athleteId]=saved;});
    closeModal();toast(`${name} added to every checkpoint.`);
  } finally {busy=false;if(button.isConnected){button.disabled=false;button.textContent='Add athlete';}render();}
}
function joinDialog() {
  if(!hasConfig()) { setupDialog();return; }
  const invite=new URLSearchParams(location.hash.slice(1)).get('join')||'';
  openModal('Join your coaching crew','Open the starter’s invite link or paste the complete race code.',`<label class="field">Your coach name<input id="coachName" maxlength="40" value="${esc(store.coachName)}" autocomplete="name" placeholder="Coach name"></label><label class="field">Coach invite<input id="inviteInput" value="${esc(invite)}" placeholder="Paste invite link or code" autocomplete="off" autocapitalize="off" spellcheck="false"></label>${actions('Join race','save-join')}`);
}
async function joinRace() {
  if(busy) return;
  const {id,token}=parseInvite($('#inviteInput').value);
  const coachName=$('#coachName').value.trim()||'Coach';
  busy=true;const button=$('[data-action="save-join"]');button.disabled=true;button.textContent='Joining…';
  try {
    await ensureBackend();
    const room=await backend.join(id,token,coachName);
    commit(next=>{next.coachName=coachName;next.active=id;next.sessions[id]={...next.sessions[id],mode:'live',uid:backend.uid,token,room,checkpoint:next.sessions[id]?.checkpoint||ordered(room.checkpoints)[0][0],pending:next.sessions[id]?.pending||{},createdAt:next.sessions[id]?.createdAt||Date.now(),clock:clock?{offset:clock.offset,rtt:clock.rtt,calibratedAt:clock.calibratedAt}:next.sessions[id]?.clock};});
    history.replaceState(null,'',location.pathname+location.search);
    closeModal();await attachSession();
  } finally { busy=false;if(button.isConnected){button.disabled=false;button.textContent='Join race';}render(); }
}
function inviteDialog() {
  if(practice()) return toast('Practice is this phone only. Connect the shared backend to invite coaches.');
  const code=`${store.active}.${session().token}`;
  const url=new URL(location.pathname,location.origin);url.hash=new URLSearchParams({join:code}).toString();
  openModal('Invite your timing crew','Anyone with this private invite can join as a coach. Share only with your crew.',`<div class="invite-code">${esc(url.href)}</div><div class="stack"><button class="button primary" data-action="share">↗ Share coach invite</button><button class="button" data-action="copy-invite">Copy link</button></div><p class="bottom-note" style="margin-top:17px">Coaches open the same app, join, select their checkpoint, and sync their clock before the start. The starter identity stays on the device that created the race.</p>`);
}
function inviteURL() { const url=new URL(location.pathname,location.origin);url.hash=new URLSearchParams({join:`${store.active}.${session().token}`}).toString();return url.href; }
function setupDialog() {
  openModal('Connect live sharing','One shared Firebase project keeps your coaches’ phones connected.',`<div class="notice blue">The app interface and local practice are ready. Multi-device races are not enabled until this setup is complete.</div><ol class="check-list"><li>Create a project in the <a href="https://console.firebase.google.com/" target="_blank" rel="noopener noreferrer">Firebase console</a>, then register a Web app.</li><li>Enable <strong>Authentication → Anonymous</strong>.</li><li>Create a <strong>Realtime Database</strong> in locked mode. Publish the supplied <a href="./database.rules.json" target="_blank" rel="noopener">database rules</a>, not public test-mode rules.</li><li>Copy your Web configuration, including databaseURL, below. Do not paste passwords, private keys, or service-account files.</li><li>Use this same configuration on each phone, or have it added to this app once. <a href="./README.md" target="_blank" rel="noopener">Full setup guide</a></li></ol><label class="field">Firebase Web configuration · JSON<textarea id="configInput" rows="5" spellcheck="false" placeholder='{"apiKey":"…","authDomain":"…","databaseURL":"https://…","projectId":"…","appId":"…"}'>${store.config?esc(JSON.stringify(store.config,null,2)):configuredBackend?esc(JSON.stringify(configuredBackend,null,2)):''}</textarea></label>${actions('Save & connect','save-config')}`);
}
function helpDialog() {
  openModal('Race-day quick guide','One starter. One shared race. A checkpoint for every coach.',`<ol class="check-list"><li>The starter creates the race, adds each athlete’s goal finish time, enters checkpoint distances, and shares the private coach invite.</li><li>If someone was missed, the starter can use <strong>＋ Add athlete</strong> before or during the race. The athlete appears on every connected coach’s phone.</li><li>Every coach joins while online, picks a checkpoint, and synchronizes their clock. Check the Crew tab.</li><li>The starter synchronizes their clock before the gun, then taps <strong>Start at the gun</strong>. The clock begins on that tap with no countdown.</li><li>Tap athletes as they pass. The Results tab shows live goal comparisons: green + is ahead of goal pace; red − is behind.</li><li>The timing list follows athletes’ latest checkpoint order. Yellow means saved on this phone but pending upload.</li><li>For a false start, the starter taps <strong>False start · reset</strong>, confirms, then taps Start again at the next gun.</li><li>If service drops, keep this app open. Taps are retained locally and retried when service returns.</li><li>Do not clear browser storage or use private browsing during a race. Export results and a backup afterward.</li></ol><div class="notice">Goal comparisons assume an even pace from start to finish. This is estimated, manual coaching timing—not certified race timing.</div><div class="stack"><button class="button" data-action="setup">Live sharing setup</button><button class="button" data-action="close">Got it</button></div>`);
}
function download(text,name,type) {const blob=new Blob([text],{type});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(link.href),10000);}
function exportResults() {const s=session();if(!s)return;download(resultsCSV(s.room,s.pending),`splitline-results-${store.active}.csv`,'text/csv;charset=utf-8');toast(pendingCount()?'Export includes pending splits labeled PENDING.':'Results exported.');}
function exportBackup() {const s=session();if(!s)return;const {token,...safe}=s;const room={...safe.room};delete room.invite;room.members=Object.fromEntries(Object.entries(room.members||{}).map(([id,m])=>[id,{name:m.name}]));download(JSON.stringify({...safe,room,exportedAt:new Date().toISOString()},null,2),`splitline-backup-${store.active}.json`,'application/json');toast('Backup includes raw taps, undo records, and pending uploads.');}
async function leaveRace() {
  if(pendingCount() && !confirm('This phone has pending uploads. They remain stored, but will only upload when you reopen this race. Leave the race view?'))return;
  unsubscribe?.();unsubscribe=null;await wakeLock?.release();wakeLock=null;
  const id=store.active;
  if(session()?.mode==='live' && backend?.online) {
    try { await backend.presence(id,{name:store.coachName||'Coach',checkpointId:session().checkpoint,clockReady:false},false); } catch { /* Leaving does not discard timing data. */ }
  }
  commit(next=>{next.active=null;});pendingStart=null;pendingReset=null;view='timing';render();
}

async function handleAction(action,element,pressedAt) {
  switch(action) {
    case 'close':closeModal();break;
    case 'home':await leaveRace();break;
    case 'create':createDialog('live');break;
    case 'practice':createDialog('practice');break;
    case 'save-practice':await createRace('practice');break;
    case 'save-race':await createRace('live');break;
    case 'save-roster':saveRosterFromForm();break;
    case 'add-athlete':addAthleteDialog();break;
    case 'confirm-add-athlete':await addAthlete();break;
    case 'join':joinDialog();break;
    case 'save-join':await joinRace();break;
    case 'resume':commit(next=>{next.active=element.dataset.id;});await attachSession();break;
    case 'view':view=element.dataset.view;render();break;
    case 'tap':recordTap(element.dataset.id);break;
    case 'undo':undo(element.dataset.id);break;
    case 'last-undo':{const e=allEffectiveEvents().find(e=>e.coachId===uid());if(e)undo(e.id);break;}
    case 'start': {
      if(!isOwner() || !online())throw new Error('The starter must be online to start a shared race.');
      if(busy || session().room.state.status!=='ready')throw new Error('This race is not waiting to start.');
      if(!practice()&&(!clock||Date.now()-clock.calibratedAt>300000))throw new Error('Sync the starter clock before the gun, then tap Start.');
      const startedAt=pressedAt, run=runNumber(session().room), id=store.active;
      busy=true;pendingStart={startedAt,run,id};render();
      try {
        if(practice())saveSession(s=>{s.room.state={status:'running',startedAt,endedAt:0,run};});
        else {const confirmed=await backend.start(id,startedAt,run);if(store.active===id)saveSession(s=>{s.room.state=confirmed;});}
        await requestWakeLock();toast('Race started at your tap.');
      } finally { pendingStart=null;busy=false;render(); }
      break;
    }
    case 'false-start': {
      if(!isOwner() || session().room.state.status!=='running')throw new Error('Only the starter can reset a running race.');
      openModal('Reset after a false start?','The timer will stop and return to zero on every connected phone.',`<div class="notice">All splits from attempt ${runNumber(session().room)} will leave the current results. They remain in the raw backup. Coaches who are offline will see the reset when they reconnect.</div>${actions('Reset race to ready','confirm-reset')}`);
      break;
    }
    case 'confirm-reset': {
      if(!isOwner() || !online() || session().room.state.status!=='running')throw new Error('The starter must be online to reset a running race.');
      const id=store.active, nextRun=runNumber(session().room)+1;
      busy=true;pendingReset={id,nextRun};closeModal();render();
      try {
        const ready=practice()?{status:'ready',startedAt:0,endedAt:0,run:nextRun}:await backend.reset(id,nextRun);
        if(store.active===id)saveSession(s=>{archiveOldPending(s,{state:ready});s.room.state=ready;});
        toast('False start reset. Tap Start at the next gun.');
      } catch(error) {
        if(/permission.denied|PERMISSION_DENIED/.test(String(error.code||'')+error.message))throw new Error('False-start reset needs the updated Firebase Realtime Database rules. Publish the current database.rules.json, then try again.');
        throw error;
      } finally {pendingReset=null;busy=false;render();}
      break;
    }
    case 'finish':openModal('End this race?','Only end after all checkpoint recording is complete. Pending offline splits can still upload afterward.',`<div class="notice">The race cannot be restarted. Create a new race for another heat.</div>${actions('End race','confirm-finish')}`);break;
    case 'confirm-finish':{if(!isOwner()||!online())throw new Error('The starter must be online to end the race.');const endedAt=Math.round(timeNow());if(endedAt<session().room.state.startedAt)throw new Error('The shared start has not been confirmed yet.');if(practice())saveSession(s=>{s.room.state.status='finished';s.room.state.endedAt=endedAt;});else await backend.finish(store.active,endedAt);closeModal();render();break;}
    case 'calibrate':await calibrateClock();toast('Clock estimate synchronized.');break;
    case 'invite':inviteDialog();break;
    case 'share':if(navigator.share){try{await navigator.share({title:'Join our SplitLine race',url:inviteURL()});}catch(e){if(e.name!=='AbortError')throw e;}}else{await navigator.clipboard.writeText(inviteURL());toast('Coach invite copied.');}break;
    case 'copy-invite':await navigator.clipboard.writeText(inviteURL());toast('Coach invite copied.');break;
    case 'export':exportResults();break;
    case 'backup':exportBackup();break;
    case 'retry':saveSession(s=>Object.values(s.pending).forEach(x=>delete x.error));render();flushQueue();break;
    case 'setup':if($('#modal').open)closeModal();setupDialog();break;
    case 'save-config':{
      if(session()?.mode==='live')throw new Error('Leave the race view before changing the backend configuration.');
      const config=cleanConfig(JSON.parse($('#configInput').value));
      if(Object.values(store.sessions).some(s=>s.mode==='live'&&Object.keys(s.pending||{}).length))throw new Error('Upload or recover existing pending splits before changing backend projects.');
      commit(next=>{next.config=config;});stopConnection?.();backend?.dispose();backend=null;clock=null;
      await ensureBackend();closeModal();toast('Shared backend connected.');if(new URLSearchParams(location.hash.slice(1)).has('join'))joinDialog();break;
    }
    case 'help':helpDialog();break;
  }
}
document.addEventListener('click',async event=>{const element=event.target.closest('[data-action]');if(!element||element.disabled)return;const pressedAt=element.dataset.action==='start'?Math.round(timeNow()):undefined;event.preventDefault();try{await handleAction(element.dataset.action,element,pressedAt);}catch(error){formError(error);}});
document.addEventListener('input',event=>{if(event.target.id==='athleteSearch'){search=event.target.value;render();}});
document.addEventListener('change',event=>{
  if(event.target.id==='savedRoster') {
    const roster=store.rosters[event.target.value];
    $('#roster').value=roster?rosterText(roster.athletes):'';
    $('#rosterName').value=roster?.name||'';
  }
  if(event.target.id==='rosterFile')uploadRoster(event.target.files?.[0]).catch(formError);
  if(event.target.id==='checkpoint'){try{saveSession(s=>{s.checkpoint=event.target.value;});render();updatePresence();}catch(error){toast(friendly(error));}}
  if(event.target.id==='resultCheckpoint'){resultCheckpoint=event.target.value;render();}
});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){requestWakeLock();updateClock();flushQueue();}});
window.addEventListener('online',()=>{if(session()?.mode==='live'&&!backend)attachSession();else flushQueue();});
window.addEventListener('beforeunload',event=>{if(pendingCount()){event.preventDefault();event.returnValue='Pending splits are saved on this phone. Reopen this race to upload them.';}});
window.addEventListener('storage',event=>{if(event.key===KEY)toast('Another tab changed SplitLine data. Use only one timing tab per phone, then reload this tab.');});
window.addEventListener('hashchange',()=>{if(new URLSearchParams(location.hash.slice(1)).has('join')){if(hasConfig())joinDialog();else setupDialog();}});
setInterval(updateClock,100);
setInterval(()=>{if(online())flushQueue();},5000);
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{});
render();
if(session())attachSession();
else if(hasConfig())ensureBackend().then(()=>{if(new URLSearchParams(location.hash.slice(1)).has('join'))joinDialog();}).catch(()=>{});
else if(new URLSearchParams(location.hash.slice(1)).has('join'))setupDialog();
