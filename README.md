# starboard

Un panneau latéral pour Claude Code dans lequel d'autres mods publient leur section (contexte git, Docker, sessions…), au lieu d'occuper le footer ou d'ouvrir chacun leur propre panneau.
n> *Starboard* : tribord, le côté droit du navire — là où le panneau s'ancre.

| Mod | Rôle |
| --- | --- |
| `sidebar` | L'hôte : ajoute `$.sidebar.publish(section)` / `$.sidebar.remove(id)`, dessine le panneau, commande `/sidebar` |
| `workspace-info` | Section « Contexte » : branche, worktree, ticket Jira tiré du nom de branche. Sans `sidebar`, s'affiche dans le footer |

## Installation

À l'invite d'une session Claude Code dans le terminal :

```
/plugin install sidebar --marketplace GabrielBlondeau-Kirby/starboard
/plugin install workspace-info --marketplace GabrielBlondeau-Kirby/starboard
```

Répondre `y` pour ajouter le marketplace, puis choisir la portée. Depuis un shell :

```
claude plugin install sidebar --marketplace GabrielBlondeau-Kirby/starboard
```

Le panneau s'ouvre au démarrage si le terminal est assez large (plein écran, 110 colonnes et plus), sinon avec `/sidebar`.

## Brancher son propre mod

`sidebar` est facultatif : un mod ne le déclare pas en dépendance. Il appelle `$.sidebar.publish` dans un `try` et garde son affichage de base dans le `catch`.

```ts
type SidebarRow = { label?: string; value: string; status?: 'ok' | 'warn' | 'error' | 'off'; dim?: boolean }
type SidebarSection = { id: string; title: string; order?: number; rows: SidebarRow[] }
type WithSidebar = Engine & { sidebar: { publish: (section: SidebarSection) => Promise<void> } }

async function refresh($: Engine) {
  const rows: SidebarRow[] = [{ label: 'état', value: 'tout va bien', status: 'ok' }]
  try {
    await ($ as WithSidebar).sidebar.publish({ id: 'mon-mod', title: 'Mon mod', order: 30, rows })
  } catch {
    $.ui.status(rows.map(row => row.value).join(' · '))
  }
}
```

Le contrat complet est dans `sidebar/types/index.d.ts`, la conception dans `docs/conception.md`.
