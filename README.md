# starboard

Un panneau latéral pour Claude Code dans lequel d'autres mods publient leur section (contexte git, Docker, sessions…), au lieu d'occuper le footer ou d'ouvrir chacun leur propre panneau.
> *Starboard* : tribord, le côté droit du navire — là où le panneau s'ancre.

| Mod | Rôle |
| --- | --- |
| `starboard` | L'hôte : ajoute `$.starboard.publish(section)` / `$.starboard.remove(id)`, dessine le panneau, commande `/starboard` |
| `workspace-info` | Section « Contexte » : branche, worktree, ticket Jira tiré du nom de branche. Sans `starboard`, s'affiche dans le footer |
| `ci-status` | Section « CI » : état de la CI Azure DevOps de la branche (PR, builds, étapes en échec), `/ci on\|off`. Sans `starboard`, s'affiche dans le footer |
| `navi` | *Hey, listen!* Panneau des sessions Claude Code locales, `/navi` : qui parle à qui, et mise en relation de deux sessions par glisser-déposer |

## Installation

À l'invite d'une session Claude Code dans le terminal :

```
/plugin install starboard --marketplace GabrielBlondeau-Kirby/starboard
/plugin install workspace-info --marketplace GabrielBlondeau-Kirby/starboard
/plugin install ci-status --marketplace GabrielBlondeau-Kirby/starboard
/plugin install navi --marketplace GabrielBlondeau-Kirby/starboard
```

Répondre `y` pour ajouter le marketplace, puis choisir la portée. Depuis un shell :

```
claude plugin install starboard --marketplace GabrielBlondeau-Kirby/starboard
```

Le panneau s'ouvre au démarrage si le terminal est assez large (plein écran, 110 colonnes et plus), sinon avec `/starboard`.

## Brancher son propre mod

`starboard` est facultatif : un mod ne le déclare pas en dépendance. Il appelle `$.starboard.publish` dans un `try` et garde son affichage de base dans le `catch`.

```ts
type StarboardRow = { label?: string; value: string; status?: 'ok' | 'warn' | 'error' | 'off'; dim?: boolean }
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

Le contrat complet est dans `starboard/types/index.d.ts`, la conception dans `docs/conception.md`.

## Licence

MIT — voir [LICENSE](LICENSE).
