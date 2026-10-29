# starboard

Un panneau latéral pour Claude Code dans lequel d'autres mods publient leur section (contexte git, Docker, sessions…), au lieu d'occuper le footer ou d'ouvrir chacun leur propre panneau.
> *Starboard* : tribord, le côté droit du navire — là où le panneau s'ancre.

| Mod | Rôle |
| --- | --- |
| `starboard` | L'hôte : ajoute `$.starboard.publish(section)` / `$.starboard.remove(id)`, dessine le panneau (une carte pastel par section, couleur tirée de son id, titre contrasté ; ▲ ▼ pour réordonner les sections, ordre gardé d'une session à l'autre), ⇤ pour rabattre le panneau en une ligne au-dessus du prompt, ⇥ ou `/starboard` pour le rouvrir, commande `/starboard` (`/starboard reset` : ordre par défaut) |
| `workspace-info` | Section « Contexte » : branche, worktree, id de session (premier bloc), ticket Jira tiré du nom de branche. Avec les options Jira, son titre, son statut et un lien vers le ticket. Sur un dépôt Azure DevOps, la PR de la branche : lien, statut (✅ Completed, 📝 Draft, ⏳ Active) et approbation des relecteurs (PAT `AZURE_ACCESS_TOKEN` en env ou dans `docker/.env`). Si Claude écrit dans un autre worktree que celui de la session (Edit/Write, `cd`, `git -C`), une ligne ⚠ « travail » le signale, avec ↪ pour y basculer la session (`/cd`) quand ce build l'a. Sans `starboard`, s'affiche dans le footer |
| `ci-status` | Section « CI » : état de la CI Azure DevOps de la branche (numéro de PR dans le résumé, pipelines cliquables, builds, étapes en échec ; le détail de la PR est dans Contexte), `/ci on\|off`. Sans `starboard`, s'affiche dans le footer |
| `navi` | *Hey, listen!* Panneau des sessions Claude Code locales, `/navi` : qui parle à qui, mise en relation par glisser-déposer, `/navi cut` et `cut-all` pour couper. Section « Sessions » dans starboard |
| `docker-stacks` | Section « Docker » : stacks Compose actives (filtrées par préfixe) et leur mémoire, alerte au-delà d'environ 80 % de la VM Docker, `/docker`. Par défaut, seulement les stacks de la session (lancées depuis son worktree ou nommées d'après sa branche) : `/docker all` ou ☰ pour tout voir, `/docker session` ou ◎ pour revenir. `/docker clean` ou 🧹 arrête (`compose down`, volumes gardés) les stacks dont le worktree n'existe plus. Sans `starboard`, footer en cas d'alerte |

## Installation

À l'invite d'une session Claude Code dans le terminal :

```
/plugin install starboard --marketplace GabrielBlondeau-Kirby/starboard
/plugin install workspace-info --marketplace GabrielBlondeau-Kirby/starboard
/plugin install ci-status --marketplace GabrielBlondeau-Kirby/starboard
/plugin install navi --marketplace GabrielBlondeau-Kirby/starboard
/plugin install docker-stacks --marketplace GabrielBlondeau-Kirby/starboard
```

Répondre `y` pour ajouter le marketplace, puis choisir la portée. Depuis un shell :

```
claude plugin install starboard --marketplace GabrielBlondeau-Kirby/starboard
```

Le panneau s'ouvre au démarrage si le terminal est assez large (plein écran, 110 colonnes et plus), sinon avec `/starboard`.

## Ticket Jira de workspace-info

`/config`, plugin `workspace-info` : `jiraUrl` (par exemple `https://monsite.atlassian.net`) fait de la clé un lien ; `jiraEmail` et `jiraToken` (token API Atlassian, gardé dans le stockage sécurisé) ajoutent le titre et le statut, relus toutes les 5 minutes. Sans ces options, la clé seule.

## Brancher son propre mod

`starboard` est facultatif : un mod ne le déclare pas en dépendance. Il appelle `$.starboard.publish` dans un `try` et garde son affichage de base dans le `catch`.

```ts
type StarboardRow = { label?: string; value: string; status?: 'ok' | 'warn' | 'error' | 'off'; dim?: boolean; href?: string }
type StarboardSection = { id: string; title: string; order?: number; rows: StarboardRow[] }
type WithStarboard = Engine & { starboard: { publish: (section: StarboardSection) => Promise<void> } }

async function refresh($: Engine) {
  const rows: StarboardRow[] = [{ label: 'état', value: 'tout va bien', status: 'ok' }]
  try {
    await ($ as WithStarboard).starboard.publish({ id: 'mon-mod', title: 'Mon mod', order: 30, rows })
  } catch {
    $.ui.status(rows.map(row => row.value).join(' · '))
  }
}
```

Une ligne avec `href` affiche sa valeur comme un lien cliquable.

Le contrat complet est dans `starboard/types/index.d.ts`, la conception dans `docs/conception.md`.

## Licence

MIT — voir [LICENSE](LICENSE).
