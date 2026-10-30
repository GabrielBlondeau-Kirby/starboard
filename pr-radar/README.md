# pr-radar

Section « PR » de starboard (sinon footer) : une ligne d'icônes par PR Azure DevOps dont on est l'auteur ou qu'on suit, lisible d'un coup d'œil.

## Installation

```
/plugin install pr-radar --marketplace GabrielBlondeau-Kirby/starboard
```

## Lecture d'une ligne

`#62367 HelloAssoPay        ✍️ 🔵 👍2 ✅ 🚀 Ajoute le remb…`

| Case | Icônes |
| --- | --- |
| Numéro et dépôt (à gauche) | `#id` puis le nom du dépôt, 12 caractères au plus, aligné sur le plus long de la liste |
| Origine | ✍️ la mienne (auteur) · 📌 suivie |
| Statut | 🔵 active · 📝 brouillon · ⚔️ conflits · 🟣 terminée · ⚫ abandonnée |
| Approbations | 👍n relecteurs (personnes, pas équipes) ayant approuvé · ↩️ attend l'auteur · 👎 rejetée |
| CI | ✅ verte · ❌ en échec · ⏳ en cours · ⚪ aucun build (vide si la PR est fermée) |
| Auto-complete | 🚀 activé, vide sinon |
| Titre | 15 caractères |

Les icônes et le titre (à droite) sont le lien vers la PR. La couleur de la ligne : vert si approuvée et CI verte, rouge si CI en échec, conflit ou rejet, grisée si brouillon ou fermée. Le résumé de la section compte mes PR actives et les CI en échec (`✍️3 ❌1`).

## Commandes

- `/prs` : rafraîchir (sinon toutes les 60 s) et afficher la liste.
- `/prs add <url|branche|#id>` : suivre une PR. Avec une branche, la PR active de cette branche (sinon la plus récente) dans le projet courant.
- `/prs rm <id>` : ne plus la suivre.
- `/prs clean` ou 🧹 : retirer les PR suivies terminées ou abandonnées.

## Fonctionnement

- Organisation et projet tirés du remote `origin` ; hors d'un dépôt Azure DevOps, le dernier projet vu sert encore.
- PR actives dont l'utilisateur du PAT est l'auteur, plus les PR suivies (gardées d'une session à l'autre).
- CI : builds de `refs/pull/<id>/merge` du dernier commit, un par pipeline.
- PAT dans `AZURE_ACCESS_TOKEN` (env) ou `docker/.env` du worktree ou du dépôt principal. Droits : *Code (Read)*, *Build (Read)*. Il ne sort que dans l'en-tête `Authorization` des appels à `dev.azure.com`.
