// =============================================================
//  Registre des rôles de Not Cover
//  Pour ajouter un rôle : ajoute une entrée ici, un réglage dans
//  SETTINGS_ROLES si l'hôte peut l'activer, et une couleur dans le CSS
//  (.tag / .role-reveal / .dead-badge / .fl-role + la classe `cls`).
// =============================================================
//
//  label    : nom affiché
//  icon     : emoji
//  cls      : classe CSS (couleur)
//  article  : pour « C'était <article><label> ! »
//  team     : "civil" | "impostor" | "neutral"  → condition de victoire par équipe
//               civils gagnent quand il n'y a plus d'imposteur vivant,
//               imposteurs gagnent quand il reste ≤ 1 civil vivant,
//               les neutres ne comptent pour personne.
//  word     : "civil" | "undercover" | null      → mot reçu par le joueur
//  reveal   : true si le joueur voit son rôle sur sa carte (sinon il ne voit que son mot)
//  points   : points gagnés si son camp (ou lui) gagne
//  onElim   : effet quand il est éliminé au vote
//               "guess" → il tente de deviner le mot des civils (phase dédiée)
//               "win"   → il gagne seul (sauf si éliminé sur égalité tirée au sort)
//  firstSpeaker : false s'il ne doit jamais parler en premier
//  mask     : true si le joueur ne voit son mot que lettre par lettre
//             (1 lettre à la manche 1, une de plus à chaque manche)
//  hint     : phrase affichée sur sa carte
export const ROLES = {
  civil: {
    label: "Civil", icon: "🙂", cls: "civil", article: "un ",
    team: "civil", word: "civil", reveal: false, points: 2,
    hint: "Civil ou Undercover ? À toi de le découvrir…",
  },
  undercover: {
    label: "Undercover", icon: "🕵️", cls: "under", article: "l'",
    team: "impostor", word: "undercover", reveal: false, points: 10,
    hint: "Civil ou Undercover ? À toi de le découvrir…",
  },
  mrwhite: {
    label: "Mr. White", icon: "👻", cls: "white", article: "",
    team: "impostor", word: null, reveal: true, points: 6,
    onElim: "guess", firstSpeaker: false,
    hint: "Tu n'as pas de mot. Écoute les autres et bluffe !",
  },
  borgne: {
    label: "Borgne", icon: "🧐", cls: "borgne", article: "le ",
    team: "civil", word: "civil", reveal: true, points: 4,
    mask: true, firstSpeaker: false,
    hint: "Tu es civil, mais tu ne vois qu'une lettre du mot… et une de plus à chaque manche.",
  },
  clown: {
    label: "Clown", icon: "🤡", cls: "clown", article: "le ",
    team: "neutral", word: "civil", reveal: true, points: 8,
    onElim: "win",
    hint: "Tu as le mot des civils… mais tu gagnes seul si tu te fais éliminer au vote. Sois suspect !",
  },
};

// Titres de fin de partie, par vainqueur (une équipe ou un rôle qui gagne seul)
export const WIN_SCREENS = {
  civil: { title: "Les Civils gagnent !", emo: "🙂" },
  impostors: { title: "Les Imposteurs gagnent !", emo: "🕵️" },
  mrwhite: { title: "Mr. White a deviné !", emo: "👻" },
  clown: { title: "Le Clown vous a bien eus !", emo: "🤡" },
};

// Rôles optionnels activables par l'hôte (interrupteur dans le salon)
export const SETTINGS_ROLES = [
  { key: "mrwhite", setting: "mrwhite", sub: "joueur sans mot" },
  { key: "borgne", setting: "borgne", sub: "civil qui voit une lettre de plus par manche" },
  { key: "clown", setting: "clown", sub: "gagne s'il se fait éliminer" },
];

export const DEFAULT_SETTINGS = { undercover: 1, mrwhite: false, borgne: false, clown: false, clueTime: 45 };

export const maxImpostors = (n) => Math.max(1, Math.floor((n - 1) / 2));

/**
 * Composition réelle pour n joueurs à partir des réglages.
 * Les rôles qui ne rentrent pas sont ignorés (et signalés dans `blocked`).
 */
export function composition(n, settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const max = maxImpostors(Math.max(n, 3));
  const counts = { undercover: Math.min(Math.max(1, s.undercover || 1), max) };
  const blocked = [];
  let imp = counts.undercover;
  let used = counts.undercover;

  for (const { key, setting } of SETTINGS_ROLES) {
    if (!s[setting]) continue;
    const r = ROLES[key];
    const nextImp = imp + (r.team === "impostor" ? 1 : 0);
    const civLeft = n - used - 1;
    const ok =
      r.team === "impostor" ? nextImp <= max
      : r.team === "civil" ? civLeft >= 1 // il reste au moins un civil "normal"
      : civLeft >= 2 && civLeft > nextImp; // un neutre ne doit pas déséquilibrer la partie
    if (ok) { counts[key] = 1; used++; imp = nextImp; } else blocked.push(key);
  }
  counts.civil = Math.max(0, n - used);
  return { counts, blocked, max };
}

/** Positions des lettres d'un mot (espaces, tirets et apostrophes restent visibles). */
export const letterIndexes = (word) => [...word].map((c, i) => (/[\p{L}\p{N}]/u.test(c) ? i : -1)).filter((i) => i >= 0);

/**
 * Mot partiellement visible : les `count` premières positions de `order` sont révélées.
 * ex. maskWord("Chocolat", [3, 0, 7], 2) → "C _ _ c _ _ _ _"
 */
export function maskWord(word, order, count) {
  const shown = new Set(order.slice(0, count));
  return [...word].map((c, i) => (/[\p{L}\p{N}]/u.test(c) && !shown.has(i) ? "_" : c)).join(" ");
}
