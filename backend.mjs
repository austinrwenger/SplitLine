// Only loaded when a shared backend is configured; local practice needs no CDN.
const VERSION = '12.19.0';
const CDN = `https://www.gstatic.com/firebasejs/${VERSION}/`;

export async function connectBackend(config) {
  const [appSDK, authSDK, dbSDK] = await Promise.all([
    import(CDN + 'firebase-app.js'), import(CDN + 'firebase-auth.js'), import(CDN + 'firebase-database.js')
  ]);
  const app = appSDK.getApps()[0] || appSDK.initializeApp(config);
  const auth = authSDK.getAuth(app);
  await auth.authStateReady();
  if (!auth.currentUser) await authSDK.signInAnonymously(auth);
  const uid = auth.currentUser.uid;
  const db = dbSDK.getDatabase(app);
  const { ref, set, get, onValue, runTransaction, serverTimestamp, onDisconnect } = dbSDK;
  let connected = false;
  const connectionListeners = new Set();
  const unsubscribeConnection = onValue(ref(db, '.info/connected'), snapshot => {
    connected = snapshot.val() === true;
    for (const callback of connectionListeners) callback(connected);
  });
  const connectionWait = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { connectionListeners.delete(check); reject(new Error('Cannot reach the shared database. Check service and Firebase setup.')); }, 12000);
    const check = online => { if (online) { clearTimeout(timeout); connectionListeners.delete(check); resolve(); } };
    connectionListeners.add(check);
    if (connected) check(true);
  });
  await connectionWait;

  return {
    uid,
    get online() { return connected; },
    onConnection(callback) { connectionListeners.add(callback); callback(connected); return () => connectionListeners.delete(callback); },
    async calibrate() {
      if (!connected) throw new Error('Go online to synchronize this phone’s clock.');
      // Estimate server clock using midpoint of a write/read round trip.
      // The estimate is NOT a certified timing guarantee. Pin it during the race.
      const samples = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await set(ref(db, `clock/${uid}`), { at: serverTimestamp() });
        const snapshot = await get(ref(db, `clock/${uid}`));
        const end = performance.now();
        const at = snapshot.val()?.at;
        if (Number.isFinite(at)) samples.push({ anchor: at - (start + end) / 2, rtt: end - start });
      }
      if (!samples.length) throw new Error('Clock calibration failed. Try again before starting.');
      samples.sort((a, b) => a.rtt - b.rtt);
      return { ...samples[0], calibratedAt: Date.now() };
    },
    async create(id, room) { await set(ref(db, `races/${id}`), room); },
    async join(id, token, name) {
      // A member must prove possession of the private coach invite before reading.
      await set(ref(db, `races/${id}/members/${uid}`), { name, invite: token });
      const snapshot = await get(ref(db, `races/${id}`));
      if (!snapshot.exists()) throw new Error('Race not found. Check the invite.');
      return snapshot.val();
    },
    subscribe(id, callback, error) { return onValue(ref(db, `races/${id}`), snapshot => callback(snapshot.val()), error); },
    async presence(id, value, active = true) {
      const path = ref(db, `races/${id}/presence/${uid}`);
      await onDisconnect(path).set({ ...value, online: false, seenAt: serverTimestamp() });
      await set(path, { ...value, online: active, seenAt: serverTimestamp() });
    },
    async start(id, startedAt, run) {
      const result = await runTransaction(ref(db, `races/${id}/state`), state => {
        if (!state || state.status !== 'ready' || (state.run || 1) !== run) return;
        return state.run ? { status: 'running', startedAt, endedAt: 0, run } : { status: 'running', startedAt, endedAt: 0 };
      }, { applyLocally: false });
      if (!result.committed) throw new Error('This race has already started, or the start was not confirmed.');
      return result.snapshot.val();
    },
    async reset(id, run) {
      const result = await runTransaction(ref(db, `races/${id}/state`), state => {
        if (!state || state.status !== 'running' || (state.run || 1) + 1 !== run) return;
        return { status: 'ready', startedAt: 0, endedAt: 0, run };
      }, { applyLocally: false });
      if (!result.committed) throw new Error('This race was already reset or ended. Reload to see its current state.');
      return result.snapshot.val();
    },
    async finish(id, endedAt) {
      const result = await runTransaction(ref(db, `races/${id}/state`), state => {
        if (!state || state.status !== 'running') return;
        return { ...state, status: 'finished', endedAt };
      }, { applyLocally: false });
      if (!result.committed) throw new Error('Race could not be ended.');
    },
    async send(id, item) {
      const path = ref(db, `races/${id}/${item.kind === 'void' ? 'voids' : 'events'}/${item.id}`);
      // Immutable, stable IDs make retried uploads idempotent (not duplicate splits).
      const result = await runTransaction(path, existing => existing ? undefined : item.data, { applyLocally: false });
      const saved = result.snapshot.val();
      if (!saved || saved.coachId !== item.data.coachId || (item.kind === 'event' && (saved.elapsedMs !== item.data.elapsedMs || saved.athleteId !== item.data.athleteId || saved.checkpointId !== item.data.checkpointId))) throw new Error('Split upload did not match the saved tap.');
    },
    dispose() { unsubscribeConnection(); connectionListeners.clear(); }
  };
}
