// "Serveur" du mode local : un SharedWorker partagé par tous les onglets.
// Il applique les écritures dans l'ordre et diffuse l'arbre complet à chaque changement.
let tree = {};
const ports = new Set();
const parts = (p) => p.split("/").filter(Boolean);
function clean(n) {
  if (n && typeof n === "object") {
    for (const k of Object.keys(n)) { n[k] = clean(n[k]); if (n[k] == null) delete n[k]; }
    return Object.keys(n).length ? n : null;
  }
  return n;
}
function write(p, v) {
  const ks = parts(p);
  let n = tree;
  for (let i = 0; i < ks.length - 1; i++) { if (typeof n[ks[i]] !== "object" || n[ks[i]] == null) n[ks[i]] = {}; n = n[ks[i]]; }
  if (v == null) delete n[ks[ks.length - 1]]; else n[ks[ks.length - 1]] = v;
}
onconnect = (e) => {
  const port = e.ports[0];
  ports.add(port);
  port.onmessage = ({ data }) => {
    if (data.bye) { ports.delete(port); }
    if (data.ops) {
      for (const [p, v] of data.ops) write(p, v);
      tree = clean(tree) || {};
      const msg = { tree };
      for (const pt of ports) pt.postMessage(msg);
    }
  };
  port.postMessage({ tree });
};
