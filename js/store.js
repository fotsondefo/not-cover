// Couche de données temps réel.
// - Firebase Realtime Database + Auth anonyme si js/firebase-config.js est rempli
// - Sinon "mode local" : base en mémoire dans un SharedWorker partagé entre onglets,
//   pratique pour tester une partie à plusieurs onglets sans Firebase.
import { firebaseConfig } from "./firebase-config.js";

const FB_VERSION = "10.14.1";
const isConfigured = firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).includes("REPLACE");

export const store = { mode: isConfigured ? "firebase" : "local", uid: null };

/* ---------------- Firebase ---------------- */
async function initFirebase() {
  const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}`;
  const [{ initializeApp }, db, auth] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-database.js`),
    import(`${base}/firebase-auth.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const database = db.getDatabase(app);
  const a = auth.getAuth(app);
  const user = await new Promise((resolve, reject) => {
    const off = auth.onAuthStateChanged(a, (u) => { if (u) { off(); resolve(u); } });
    auth.signInAnonymously(a).catch(reject);
  });
  store.uid = user.uid;

  let offset = 0;
  db.onValue(db.ref(database, ".info/serverTimeOffset"), (s) => { offset = s.val() || 0; });
  let connCb = () => {};
  db.onValue(db.ref(database, ".info/connected"), (s) => connCb(!!s.val()));

  const r = (p) => db.ref(database, p);
  Object.assign(store, {
    now: () => Date.now() + offset,
    onConnection: (cb) => { connCb = cb; },
    get: async (p) => (await db.get(r(p))).val(),
    set: (p, v) => db.set(r(p), v),
    update: (p, v) => db.update(r(p), v),
    remove: (p) => db.remove(r(p)),
    push: (p, v) => { const k = db.push(r(p)); db.set(k, v); return k.key; },
    onValue: (p, cb, opts = {}) => {
      const q = opts.limitLast ? db.query(r(p), db.limitToLast(opts.limitLast)) : r(p);
      return db.onValue(q, (s) => cb(s.val()), (err) => console.warn("onValue", p, err));
    },
    onDisconnect: (p) => {
      const od = db.onDisconnect(r(p));
      return { set: (v) => od.set(v), remove: () => od.remove(), update: (v) => od.update(v), cancel: () => od.cancel() };
    },
  });
}

/* ---------------- Mode local (multi-onglets) ---------------- */
// Un SharedWorker joue le rôle de serveur : écritures ordonnées, diffusion à tous les onglets.
async function initLocal() {
  if (!("SharedWorker" in window)) throw new Error("Mode local indisponible sur ce navigateur : configure Firebase (js/firebase-config.js).");
  let uid = sessionStorage.getItem("nc_local_uid");
  if (!uid) { uid = "u" + Math.random().toString(36).slice(2, 10); sessionStorage.setItem("nc_local_uid", uid); }
  store.uid = uid;

  const worker = new SharedWorker(new URL("./local-db-worker.js", import.meta.url), { name: "notcover-db" });
  const port = worker.port;
  let tree = {};
  const listeners = new Set();
  const parts = (p) => p.split("/").filter(Boolean);
  const read = (t, p) => parts(p).reduce((n, k) => (n == null ? null : n[k] ?? null), t);
  const notify = () => {
    for (const l of listeners) {
      let v = read(tree, l.p);
      if (v && l.limitLast) v = Object.fromEntries(Object.entries(v).slice(-l.limitLast));
      const j = JSON.stringify(v ?? null);
      if (j !== l.last) { l.last = j; l.cb(JSON.parse(j)); }
    }
  };
  await new Promise((resolve) => {
    port.onmessage = ({ data }) => { if (data.tree) { tree = data.tree; notify(); resolve(); } };
    port.start();
  });
  const writeLocal = (p, v) => {
    const ks = parts(p);
    let n = tree;
    for (let i = 0; i < ks.length - 1; i++) { if (typeof n[ks[i]] !== "object" || n[ks[i]] == null) n[ks[i]] = {}; n = n[ks[i]]; }
    if (v == null) delete n[ks[ks.length - 1]]; else n[ks[ks.length - 1]] = v;
  };
  // Écriture optimiste locale (comme Firebase), puis le worker renvoie l'état de référence.
  const send = (ops) => {
    ops = ops.map(([p, v]) => [p, v === undefined || v === null ? null : JSON.parse(JSON.stringify(v))]);
    for (const [p, v] of ops) writeLocal(p, v);
    port.postMessage({ ops });
    notify();
  };

  const disconnectOps = new Map();
  window.addEventListener("pagehide", () => { send([...disconnectOps]); port.postMessage({ bye: true }); });
  let pushN = 0;

  Object.assign(store, {
    now: () => Date.now(),
    onConnection: (cb) => cb(true),
    get: async (p) => JSON.parse(JSON.stringify(read(tree, p))),
    set: async (p, v) => send([[p, v]]),
    update: async (p, obj) => send(Object.entries(obj).map(([k, v]) => [`${p}/${k}`, v])),
    remove: async (p) => send([[p, null]]),
    push: (p, v) => {
      const k = Date.now().toString(36) + (pushN++).toString(36).padStart(3, "0") + Math.random().toString(36).slice(2, 5);
      send([[`${p}/${k}`, v]]);
      return k;
    },
    onValue: (p, cb, opts = {}) => {
      const l = { p, cb, last: undefined, limitLast: opts.limitLast };
      listeners.add(l); setTimeout(notify, 0);
      return () => listeners.delete(l);
    },
    onDisconnect: (p) => ({
      set: async (v) => disconnectOps.set(p, v),
      remove: async () => disconnectOps.set(p, null),
      update: async (obj) => { for (const [k, v] of Object.entries(obj)) disconnectOps.set(`${p}/${k}`, v); },
      cancel: async () => { for (const k of [...disconnectOps.keys()]) if (k.startsWith(p)) disconnectOps.delete(k); },
    }),
  });
}

export async function initStore() {
  if (store.mode === "firebase") await initFirebase();
  else await initLocal();
  return store;
}
