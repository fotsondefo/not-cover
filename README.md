# Not Cover 🕵️

Jeu d'infiltration en temps réel (type Undercover) jouable sur mobile, installable en PWA.
Vanilla JS (ES modules), aucun build. Firebase Realtime Database pour le temps réel, auth anonyme.

## Tester tout de suite (sans Firebase)

```bash
cd notcover
python3 -m http.server 8080
```

Ouvre `http://localhost:8080` dans **3 onglets ou plus** (Chrome/Firefox/Safari sur ordinateur) :
tant que `js/firebase-config.js` n'est pas rempli, l'app tourne en **mode local**. Un SharedWorker
sert de mini-serveur et chaque onglet est un joueur différent.

## Brancher Firebase

1. Crée un projet sur https://console.firebase.google.com
2. **Build > Authentication > Sign-in method** : active **Anonyme**.
3. **Build > Realtime Database** : crée la base (région europe-west1 par exemple).
4. **Paramètres du projet > Vos applications > Web (</>)** : copie l'objet `firebaseConfig`
   dans `js/firebase-config.js` (avec `databaseURL`).
5. Déploie les règles + l'app :

```bash
npm i -g firebase-tools
firebase login
firebase use --add            # choisis ton projet
firebase deploy               # règles database + hosting
```

L'app est alors servie en HTTPS (obligatoire pour la PWA) sur `https://<projet>.web.app`.
Sur mobile : Chrome > « Installer l'application » / Safari > Partager > « Sur l'écran d'accueil ».

## Rejoindre une room

- **Code** : 4 caractères (sans 0/O/1/I/L pour éviter les confusions).
- **Lien** : `https://…/?r=CODE` (bouton « Inviter » = partage natif du téléphone, plus un QR code).
- Après un rechargement ou une coupure, le joueur reprend automatiquement sa place.
- Si quelqu'un arrive en cours de partie, il regarde en spectateur jusqu'à la prochaine.

## Règles implémentées

- Civils : même mot. Undercover : mot proche (et il ne sait pas qu'il est l'intrus). Mr. White : pas de mot.
- Chacun son tour donne un indice (timer réglable 30/45/60/90 s ou ∞, le tour passe automatiquement).
- Temps de parole après les indices (30 s à 3 min, choisi par l'hôte, impossible à passer).
- Vote en direct avec chrono (15/30/45/60 s, l'hôte peut le clore plus tôt). Votes visibles, modifiables jusqu'au dernier votant. Égalité : tirage au sort. Aucun vote : personne n'est éliminé.
- Mr. White éliminé : il tente de deviner le mot des civils pour gagner.
- Victoire des civils si tous les imposteurs sont éliminés, des imposteurs s'il ne reste qu'un civil.
- Points : Civil +2, Undercover +10, Mr. White +6, cumulés entre les parties de la room.
- Emotes en temps réel qui s'envolent depuis l'avatar, indicateur « en train d'écrire ».

## Architecture

```
index.html
css/style.css
js/app.js               UI + logique de jeu (l'hôte fait autorité : distribution, tours, dépouillement)
js/store.js             couche temps réel : Firebase OU mode local (même API)
js/local-db-worker.js   "serveur" du mode local
js/words.js             paires de mots (ajoute les tiennes)
js/firebase-config.js   ta config
sw.js / manifest.webmanifest / icons/
database.rules.json     règles RTDB
```

Données :

```
rooms/{CODE}/meta        host, status (lobby|reveal|clue|vote|mrwhite|elim|over), settings
rooms/{CODE}/players     name, avatar, color, online, alive, ready, typing, score
rooms/{CODE}/game        round, order, turn, turnEndsAt, elim, dead, mwGuess…
rooms/{CODE}/clues/{round}/{turn}
rooms/{CODE}/votes/{round}/{voter} = cible
rooms/{CODE}/reveal      rôles + mots, publiés en fin de partie
secrets/{CODE}/{uid}     le mot du joueur, lisible par lui seul
secrets/{CODE}/_roles    rôles complets, lisibles par l'hôte seul
emotes/{CODE}/{id}
```

Si l'hôte se déconnecte plus de 8 s, le premier joueur en ligne reprend la main (les règles lui
donnent alors accès aux secrets, la partie continue).

### Limites à connaître

- L'hôte reçoit tous les rôles (c'est lui qui distribue). Pour un anti-triche total, il faudrait
  déplacer `startGame / resolveVote / finish` dans des Cloud Functions.
- Les règles `rooms/*` sont permissives (tout utilisateur authentifié peut écrire) : parfait pour
  un jeu entre amis, à durcir pour une ouverture au grand public.
- Les rooms ne sont pas purgées automatiquement : ajoute une Cloud Function planifiée si besoin
  (supprimer les `rooms` dont `meta/createdAt` dépasse 24 h).
