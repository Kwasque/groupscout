# GroupScout

Recherche de raid pour World of Warcraft, directement sur le site : des raids qui recrutent, des
joueurs qui cherchent, et tout ce qu'il faut pour s'organiser (places par rôle, classes
recherchées, chat du raid).

```
groupscout/
└── site/       le site (Node.js, aucune dépendance npm)
```

Les données des personnages viennent de l'**API officielle de Blizzard**. Raider.IO ne sert qu'à
deux choses : la liste des raids du palier en cours (une fois par jour, côté serveur) et la
recherche d'un personnage par son nom pendant la frappe (depuis le navigateur). **Aucune requête
vers Warcraft Logs**, et plus d'indice sur 100.

## Lancer le site

Il faut **Node.js 22.5 ou plus** (base SQLite intégrée, `node:sqlite`).

```bash
cd site
cp .env.example .env      # sous Windows : copy .env.example .env
# ouvre .env : ton adresse dans ADMIN_EMAILS, et le client Battle.net (BNET_CLIENT_ID / BNET_CLIENT_SECRET)
node server.js
```

Ouvre http://localhost:3000. Tout le reste de la configuration est expliqué dans `.env.example`.

Le client Battle.net (https://develop.battle.net/access/clients) est indispensable : il sert à
lier le Battle.net des comptes (choisir son personnage) et à lire les profils. Déclare
`http://localhost:3000/api/account/bnet/callback` et `<PUBLIC_URL>/api/account/bnet/callback`
comme adresses de retour.

## Accueil

Un visiteur voit la vitrine et les raids qui recrutent. Un compte connecté voit son tableau de
bord, avec le **calendrier des 14 prochains jours** :

- **un ruban** avec un bouton par jour : nombre de raids et répartition Normal / Héroïque /
  Mythique. Un cercle lavande marque tes jours : plein si tu y es (ton annonce, une place), en
  pointillé si ce n'est pas encore sûr (candidature, place proposée) ;
- **le jour choisi** : heures de début en barres (un clic filtre sur ce créneau), filtres par
  difficulté et « Je peux postuler », puis 4 raids au plus, les tiens d'abord. Le lien du bas
  ouvre `/groups` filtré sur ce jour ;
- **à droite** : ton prochain raid avec un compte à rebours, puis ta place proposée, tes
  candidatures, ton annonce et ta recherche.

Le calendrier tient avec des centaines d'annonces : `GET /api/groups/calendar` ne renvoie que
`[début, difficulté]` de chaque annonce, et les annonces du jour choisi arrivent avec
`GET /api/groups?from=&to=`.

## Trouver un groupe (`/groups`)

- **Raids qui recrutent** (`/groups`) : les annonces en cours, filtrables par difficulté, jour et
  langue. « Tu regardes avec » choisit le personnage avec lequel on postulerait (et « Seulement ceux
  où je peux postuler » cache le reste).
- **Poster une annonce** (`/groups/new`) : titre facultatif, Reclear ou Progress, raid, difficulté,
  boss prévus, date et horaires (jusqu'à 14 jours à l'avance, à l'heure de chacun), langues parlées,
  composition (2 / 4 / 14 par défaut), classes recherchées avec un nombre (**préférées** : tout le
  monde peut postuler ; **obligatoires** : seulement ces classes), conditions conseillées (ilvl,
  progression, juste affichées), Discord obligatoire ou non (le lien n'est montré qu'aux membres et
  aux joueurs invités) et description. Une annonce de raid à la fois par compte.
- **Postuler** : avec un de ses personnages Battle.net, un rôle et une note. La candidature emporte
  le profil du personnage tel que Blizzard le donne (spé, niveau d'objet, progression, cote
  Mythique+) ; « Actualiser » renvoie un profil à jour. Le leader voit les candidatures dans l'ordre
  d'arrivée, avec la progression dans la difficulté de l'annonce et des repères (classe recherchée,
  rôle complet, sous l'ilvl ou la progression conseillés). Un clic sur un pseudo ouvre sa fiche.
- **Le leader** invite petit à petit ; le joueur doit **accepter** la place. Accepter retire ses
  autres candidatures sur le même créneau. Le leader peut nommer des **co-leaders**, retirer un
  membre, et un membre peut quitter le raid : dans les deux cas **un message est obligatoire**. Un
  **chat** est ouvert aux membres du raid.
- **Je cherche un raid** (`/groups/search`) : personnage, rôles, difficultés, raid et boss visés,
  créneau, langues et un mot. Les leaders voient les joueurs dont le créneau correspond
  (`/groups/players`, et l'onglet « Joueurs qui cherchent » de leur annonce) et peuvent leur
  **proposer une place**.
- **Dans le jeu** : la page de l'annonce donne un titre, `GroupScout: CODE`, à copier. Le leader
  liste son raid avec ce titre dans la recherche de groupe du jeu, et ses membres le cherchent pour
  postuler.
- Tout se met à jour en direct sur la page du raid. Les notifications (cloche de la barre du haut)
  préviennent d'une candidature, d'une place proposée, d'une arrivée ou d'un départ, d'un raid annulé.
- Il faut un compte à l'adresse confirmée, avec un Battle.net lié. Les annonces, raids,
  candidatures et recherches sont publics ; le chat ne l'est pas. Tout est effacé 24 h après la fin
  du raid (une recherche, une heure après la fin de son créneau).

## Fiche joueur (`/player/<Pseudo>/<Serveur>`)

La loupe de la barre du haut ouvre la recherche : dès 2 lettres, les personnages trouvés (recherche
Raider.IO, EU), tes favoris et tes dernières fiches. La fiche montre, d'après l'API Blizzard :

- l'en-tête : spé, classe, serveur, dernière connexion, niveau d'objet, cote Mythique+, et son
  **main** si le propriétaire du personnage l'a choisi sur GroupScout ;
- la **progression** dans chaque raid du palier, boss par boss (portraits du journal du jeu, kills
  dans les deux plus hautes difficultés faites) ;
- les **donjons Mythique+** de la saison : meilleure clé de chacun, avec une info-bulle (cote,
  durée, groupe) ;
- l'**équipement** (feuille de personnage, statistiques, enchantements, châsses, info-bulles façon
  jeu) et les **talents** (arbres complets, bouton « Exporter » pour le jeu).

Il faut un compte à l'adresse confirmée.

## Comptes

`/login` sert à la fois à se connecter et à s'inscrire, par e-mail ou avec Google, Discord ou
Battle.net. Un code à 6 chiffres confirme l'adresse (tant que Brevo n'est pas configuré, il
s'affiche dans la console du serveur). `/account` : pseudo, mot de passe, Battle.net (et
personnage principal), Google et Discord, suppression du compte.

Un compte est **Normal**, **VIP** (un badge à côté de ses personnages) ou **Admin**. Les adresses de
`ADMIN_EMAILS` sont admin et vérifiées d'office. Mots de passe hachés (`scrypt`), essais à répétition
freinés.

## Backoffice (`/admin`)

Réservé aux admins : vue d'ensemble, **audience** (mesure maison, anonyme, sans bandeau : refus
possible depuis `/privacy#analytics`), comptes (statut, suppression, **se connecter en tant que**),
annonces et joueurs qui cherchent, Battle.net liés, sécurité. En admin, tu gères chaque annonce
comme son leader. Sur `localhost`, un petit module « Admin » en bas à gauche permet de changer de
compte d'un clic et de ne pas charger depuis le cache.

## Fichiers

| Fichier | Rôle |
|---|---|
| `site/server.js` | Serveur HTTP, routes de l'API, chargement des profils |
| `site/groups.js` | Règles et stockage de la recherche de groupe |
| `site/accounts.js`, `oauth.js`, `bnet.js`, `mail.js` | Comptes, connexions, Battle.net, e-mails |
| `site/blizzard.js`, `icons.js`, `journal.js` | API Blizzard, icônes d'objets, images du journal |
| `site/notifications.js`, `analytics.js`, `admin.js` | Notifications, audience, backoffice |
| `site/public/index.html`, `style.css` | La page unique du site |
| `site/public/js/*.js` | Le front, chargé dans l'ordre : `core`, `nav`, `auth`, `player`, `groups`, `admin`, `home` |

Le site est en français. Les textes passent par `tr()` (`public/i18n.js`) pour leurs variables et
leurs pluriels.
