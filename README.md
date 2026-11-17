# My Social Networks API

API REST du TP **My Social Networks** : refonte des API de gestion d'événements et de groupes d'un réseau social.
Développée avec **Node.js**, **Express 5** et **SQLite** (module natif `node:sqlite`, aucune autre dépendance).

## 📄 Documentation Postman

- **Documentation publiée : <https://documenter.getpostman.com/view/26750234/2sBYHbrbbp>**
Chaque requête documente l'URL du service, l'explication fonctionnelle, les données envoyées, les données retournées et les erreurs possibles, avec des exemples de réponses réelles (succès et erreurs métier).
La variable `{{baseUrl}}` vaut `http://localhost:3000/api/v1`.

## 🚀 Installation et lancement

Prérequis : **Node.js 22.5 ou plus récent** (pour `node:sqlite`).

```bash
npm install
npm start          # http://localhost:3000  
npm test           # tests de bout en bout sur une base temporaire
```

La base `data.sqlite` est créée automatiquement au premier lancement (`db.js`). Les nouvelles tables sont ajoutées à une base existante sans perte de données.

## 🗂️ Structure

```
server.js            point d'entrée, branchement des routes, gestion des erreurs
db.js                connexion SQLite + création des tables
lib/                 fonctions partagées (rôles, droits d'accès, transactions)
routes/              une route par ressource
tests/api.test.js    tests de bout en bout (node:test)
postman/             collection Postman (format YAML synchronisé)
docs/                export JSON de la collection
```

## 👤 Utilisateur qui fait l'action

L'API n'a pas d'authentification (hors du périmètre du TP). L'utilisateur qui agit est passé explicitement :
`created_by`, `author_id`, `user_id`, `driver_id` ou `added_by` dans le body, et `?user_id=` en paramètre de requête pour les lectures (contenus privés ou secrets) et les suppressions.

## 🔗 Endpoints

Préfixe : `/api/v1`

| Ressource | Endpoints |
|---|---|
| **Utilisateurs** | `POST /users` · `GET /users?q=` · `GET /users/:id` · `PUT /users/:id` · `PATCH /users/:id` · `DELETE /users/:id` |
| **Événements** | `POST /events` *(étape 1)* · `PATCH /events/:id/options` *(étape 2)* · `POST /events/:id/publish` *(étape 3)* · `GET /events` · `GET /events/:id` · `PUT /events/:id` · `PATCH /events/:id` · `DELETE /events/:id` · `GET /events/:id/share` |
| Membres d'un événement | `GET /events/:id/members` · `POST /events/:id/members` · `PATCH /events/:id/members/:userId` · `DELETE /events/:id/members/:userId` |
| **Groupes** | `POST /groups` · `GET /groups` · `GET /groups/:id` · `PUT /groups/:id` · `PATCH /groups/:id` · `DELETE /groups/:id` |
| Membres d'un groupe | `GET /groups/:id/members` · `POST /groups/:id/members` · `PATCH /groups/:id/members/:userId` · `DELETE /groups/:id/members/:userId` |
| Événements d'un groupe | `GET /groups/:id/events` · `POST /groups/:id/events` *(invite tous les membres)* |
| **Fils de discussion** | `POST /threads` · `GET /threads?group_id=` ou `?event_id=` · `GET /threads/:id` · `PATCH /threads/:id` · `DELETE /threads/:id` |
| Messages | `GET /threads/:id/messages` · `POST /threads/:id/messages` · `GET /messages/:id` · `PATCH /messages/:id` · `DELETE /messages/:id` |
| Commentaires de messages | `GET /messages/:id/comments` · `POST /messages/:id/comments` · `PATCH /messages/:id/comments/:commentId` · `DELETE /messages/:id/comments/:commentId` |
| **Albums photo** | `POST /albums` · `GET /albums?event_id=` · `GET /albums/:id` · `PATCH /albums/:id` · `DELETE /albums/:id` |
| Photos | `GET /albums/:id/photos` · `POST /albums/:id/photos` · `GET /photos/:id` · `PATCH /photos/:id` · `DELETE /photos/:id` |
| Commentaires de photos | `GET /photos/:id/comments` · `POST /photos/:id/comments` · `PATCH /photos/:id/comments/:commentId` · `DELETE /photos/:id/comments/:commentId` |
| **Sondages** | `POST /polls` · `GET /polls?event_id=` · `GET /polls/:id` · `PATCH /polls/:id` · `DELETE /polls/:id` |
| Réponses | `POST /polls/:id/answers` · `PUT /polls/:id/answers` · `GET /polls/:id/answers` · `DELETE /polls/:id/answers/:userId` · `GET /polls/:id/results` |
| **Billetterie** | `POST /ticket-types` · `GET /ticket-types?event_id=` · `GET /ticket-types/:id` · `PATCH /ticket-types/:id` · `DELETE /ticket-types/:id` |
| Billets | `POST /tickets` · `GET /tickets?event_id=` · `GET /tickets/:id` · `PATCH /tickets/:id` · `DELETE /tickets/:id` |
| **Shopping list** | `POST /shopping-items` · `GET /shopping-items?event_id=` · `GET /shopping-items/:id` · `PATCH /shopping-items/:id` · `DELETE /shopping-items/:id` |
| **Covoiturage** *(bonus)* | `POST /carpools` · `GET /carpools?event_id=` · `GET /carpools/:id` · `PATCH /carpools/:id` · `DELETE /carpools/:id` · `POST /carpools/:id/passengers` · `DELETE /carpools/:id/passengers/:userId` |

## ✅ Règles du cahier des charges

| Règle | Où / comment |
|---|---|
| Deux utilisateurs ne peuvent pas avoir le même email | `UNIQUE COLLATE NOCASE` → 409 |
| Création d'événement en 3 étapes | brouillon (`status = draft`) → options → publication |
| Un événement a 1 ou plusieurs organisateurs, plusieurs participants | table `event_members`, le dernier organisateur ne peut pas être retiré |
| Événement public / privé | un événement privé ou en brouillon n'est visible que de ses membres |
| Groupe public / privé / secret | un groupe secret est invisible (404) pour les non-membres ; rejoindre un groupe privé/secret demande un admin |
| Un groupe a 1 ou plusieurs membres et administrateurs | table `group_members`, le dernier admin ne peut pas être retiré |
| Autoriser les membres à publier / créer des événements | `allow_member_posts`, `allow_member_events` |
| Événement de groupe : invitation de tous les membres en 1 clic | `POST /groups/:id/events` |
| Partage sur les réseaux sociaux | `GET /events/:id/share` (option activée, événement public, groupe public) |
| Un fil est lié à 1 groupe **ou** 1 événement, pas les deux | `CHECK` SQL + validation → 400 |
| Messages par les membres / admins, commentaires par les membres / participants | contrôle du rôle → 403 |
| Un album est associé à 1 événement, photos et commentaires par les participants | contrôle du rôle → 403 |
| Sondage créé par un organisateur, 1 ou plusieurs questions | contrôle du rôle, au moins 1 question et 2 réponses |
| Une seule réponse par question | `PRIMARY KEY (question_id, user_id)` + clé étrangère composée (réponse ∈ question) |
| Billetterie seulement pour certains événements publics | option `ticketing_enabled` + `visibility = public` |
| Quantité de billets limitée | vérification dans une transaction → 409 |
| Une personne extérieure n'obtient qu'1 seul billet | `UNIQUE (event_id, email)` → 409 |
| Shopping list : chaque chose apportée est unique par événement | `UNIQUE (event_id, name COLLATE NOCASE)` → 409 |
| Covoiturage : places limitées, temps maximum d'écart | `seats`, `max_detour_minutes`, places restantes calculées |

## 🧪 Tests

`npm test` lance 10 scénarios de bout en bout, un par partie du cahier des charges, sur une base SQLite temporaire (la base `data.sqlite` n'est pas modifiée).

## Codes de réponse

`200` OK · `201` créé · `204` supprimé · `400` données invalides · `403` action non autorisée pour cet utilisateur · `404` introuvable · `409` conflit (doublon, stock épuisé…) · `422` règle métier non respectée