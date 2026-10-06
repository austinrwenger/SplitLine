export const MAX_ATHLETES = 20;

export function formatTime(ms, tenths = true) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const t = Math.floor(ms / 100);
  const seconds = Math.floor(t / 10) % 60;
  const minutes = Math.floor(t / 600);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${tenths ? '.' + t % 10 : ''}`;
}

export function parseRoster(text) {
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!lines.length || lines.length > MAX_ATHLETES) throw new Error('Enter 1–20 athletes, one per line.');
  const bibs = new Set();
  return Object.fromEntries(lines.map((line, i) => {
    const parts = line.split(',');
    const bib = parts.length > 1 ? parts.shift().trim() : String(i + 1);
    const name = parts.length ? parts.join(',').trim() : line;
    if (!bib || !name || bib.length > 12 || name.length > 60) throw new Error('Use a short bib and name, like 12, Alex.');
    if (bibs.has(bib.toLowerCase())) throw new Error(`Bib ${bib} is used twice.`);
    bibs.add(bib.toLowerCase());
    return [`a${i + 1}`, { bib, name, order: i }];
  }));
}

export function parseCheckpoints(text) {
  const names = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!names.length || names.length > 12) throw new Error('Enter 1–12 checkpoints, in race order.');
  if (names.some(x => x.length > 40)) throw new Error('Keep checkpoint labels under 40 characters.');
  if (new Set(names.map(x => x.toLowerCase())).size !== names.length) throw new Error('Each checkpoint needs a different label.');
  return Object.fromEntries(names.map((label, i) => [`c${i + 1}`, { label, order: i, finish: i === names.length - 1 }]));
}

export function ordered(map) { return Object.entries(map || {}).sort((a, b) => a[1].order - b[1].order); }

export const runNumber = room => room?.state?.run || 1;

export function rosterText(athletes) {
  return ordered(athletes).map(([, athlete]) => `${athlete.bib}, ${athlete.name}`).join('\n');
}

export function parseRosterImport(text) {
  const source = text.replace(/^\uFEFF/, '').trim();
  if (!source) throw new Error('The roster file is empty.');
  const lines = source.split(/\r?\n/).filter(line => line.trim());
  // Plain text uses the same "bib, name" lines as the race form.
  if (!lines[0].includes(',') && !lines[0].includes('"')) return parseRoster((/^name$/i.test(lines[0].trim()) ? lines.slice(1) : lines).join('\n'));
  const records = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(cell.trim()); if (row.some(Boolean)) records.push(row);
      row = []; cell = '';
    } else cell += ch;
  }
  if (quoted) throw new Error('The roster CSV has an unclosed quote.');
  row.push(cell.trim()); if (row.some(Boolean)) records.push(row);
  const headers = records[0].map(x => x.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const bibIndex = headers.findIndex(x => ['bib', 'bibnumber', 'number', 'athletenumber'].includes(x));
  const nameIndex = headers.findIndex(x => ['name', 'athlete', 'athletename', 'student', 'studentname'].includes(x));
  const firstIndex = headers.findIndex(x => ['firstname', 'first'].includes(x));
  const lastIndex = headers.findIndex(x => ['lastname', 'last'].includes(x));
  const hasHeader = nameIndex >= 0 || firstIndex >= 0 || lastIndex >= 0;
  const data = hasHeader ? records.slice(1) : records;
  const linesToParse = data.map((fields, i) => {
    const name = hasHeader ? nameIndex >= 0 ? fields[nameIndex] : [fields[firstIndex] || '', fields[lastIndex] || ''].filter(Boolean).join(' ') : fields.slice(1).join(', ');
    const bib = hasHeader ? bibIndex >= 0 ? fields[bibIndex] : String(i + 1) : fields[0];
    if (!bib || !name) throw new Error(`Roster row ${i + (hasHeader ? 2 : 1)} needs a bib and name.`);
    return `${bib}, ${name}`;
  });
  return parseRoster(linesToParse.join('\n'));
}

export function selectSplits(room, pending = {}) {
  const events = { ...(room.events || {}) };
  const voids = { ...(room.voids || {}) };
  for (const item of Object.values(pending)) {
    if (item.kind === 'event') events[item.id] = item.data;
    else if (item.kind === 'void') voids[item.id] = item.data;
  }
  const cells = {};
  for (const [id, event] of Object.entries(events)) {
    if (voids[id] || (event.run || 1) !== runNumber(room) || !room.athletes?.[event.athleteId] || !room.checkpoints?.[event.checkpointId] || !Number.isFinite(event.elapsedMs)) continue;
    const key = `${event.athleteId}:${event.checkpointId}`;
    const candidate = { ...event, id, pending: !!pending['event:' + id], failed: !!pending['event:' + id]?.error };
    (cells[key] ||= []).push(candidate);
  }
  for (const key of Object.keys(cells)) {
    // Consistent across devices: earliest captured split wins; event ID breaks ties.
    cells[key].sort((a, b) => a.elapsedMs - b.elapsedMs || a.id.localeCompare(b.id));
    cells[key] = { ...cells[key][0], alternatives: cells[key].slice(1) };
  }
  return cells;
}

export function timingOrder(room, checkpointId, pending = {}) {
  const athletes = ordered(room.athletes), checkpoints = ordered(room.checkpoints);
  const index = checkpoints.findIndex(([id]) => id === checkpointId);
  const cells = selectSplits(room, pending);
  const previous = checkpoints.slice(0, Math.max(0, index)).map(([id]) => id);
  const info = id => {
    const current = cells[`${id}:${checkpointId}`];
    for (let i = previous.length - 1; i >= 0; i--) {
      const split = cells[`${id}:${previous[i]}`];
      if (split) return { recorded: !!current, checkpoint: i, time: split.elapsedMs, currentTime: current?.elapsedMs ?? Infinity };
    }
    return { recorded: !!current, checkpoint: -1, time: Infinity, currentTime: current?.elapsedMs ?? Infinity };
  };
  return athletes.sort(([idA, a], [idB, b]) => {
    const x = info(idA), y = info(idB);
    return Number(x.recorded) - Number(y.recorded) || y.checkpoint - x.checkpoint || x.time - y.time || x.currentTime - y.currentTime || a.order - b.order;
  });
}

export function leaderboard(room, checkpointId, pending = {}) {
  const cells = selectSplits(room, pending);
  const cps = ordered(room.checkpoints);
  const index = cps.findIndex(([id]) => id === checkpointId);
  const previousId = index > 0 ? cps[index - 1][0] : null;
  const rows = ordered(room.athletes).map(([id, athlete]) => {
    const split = cells[`${id}:${checkpointId}`];
    const previous = previousId ? cells[`${id}:${previousId}`] : null;
    const legMs = split && (!previousId || previous) ? split.elapsedMs - (previous?.elapsedMs || 0) : null;
    return { id, ...athlete, split, legMs, backwards: legMs !== null && legMs < 0 };
  });
  rows.sort((a, b) => (a.split?.elapsedMs ?? Infinity) - (b.split?.elapsedMs ?? Infinity) || a.order - b.order);
  let rank = 0, lastTime = -1;
  rows.forEach((row, i) => {
    if (!row.split) { row.rank = null; return; }
    if (row.split.elapsedMs !== lastTime) rank = i + 1;
    row.rank = rank;
    lastTime = row.split.elapsedMs;
  });
  return rows;
}

export function csvCell(value) { return '"' + String(value ?? '').replaceAll('"', '""') + '"'; }
export function resultsCSV(room, pending = {}) {
  const cps = ordered(room.checkpoints);
  const cells = selectSplits(room, pending);
  const head = ['Bib', 'Athlete', ...cps.flatMap(([, cp]) => [cp.label + ' elapsed', cp.label + ' leg', cp.label + ' status'])];
  const rows = ordered(room.athletes).map(([id, athlete]) => {
    const values = [athlete.bib, athlete.name];
    cps.forEach(([cpid], i) => {
      const split = cells[`${id}:${cpid}`];
      const prev = i ? cells[`${id}:${cps[i - 1][0]}`] : null;
      const leg = split && (!i || prev) ? split.elapsedMs - (prev?.elapsedMs || 0) : null;
      values.push(split ? formatTime(split.elapsedMs) : '', leg === null ? '' : formatTime(leg), !split ? '' : split.failed ? 'UPLOAD FAILED' : split.pending ? 'PENDING' : split.clockQuality === 'cached' ? 'Saved; cached clock' : 'Saved');
    });
    return values;
  });
  return [head, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function cleanConfig(value) {
  const result = {};
  for (const key of ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId']) {
    if (typeof value?.[key] !== 'string' || !value[key].trim()) throw new Error(`Firebase configuration needs ${key}.`);
    result[key] = value[key].trim();
  }
  const u = new URL(result.databaseURL);
  if (u.protocol !== 'https:' || !/(\.firebaseio\.com|\.firebasedatabase\.app)$/.test(u.hostname)) throw new Error('Use the HTTPS Realtime Database URL from Firebase.');
  return result;
}

export function parseInvite(text) {
  let value = text.trim();
  if (value.includes('#')) value = new URLSearchParams(value.split('#')[1]).get('join') || '';
  const match = /^([a-f0-9]{16})\.([a-f0-9]{32})$/i.exec(value);
  if (!match) throw new Error('Paste the complete coach invite link or race code.');
  return { id: match[1].toLowerCase(), token: match[2].toLowerCase() };
}
