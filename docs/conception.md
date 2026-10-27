# Starboard pour Claude Code : récapitulatif de la discussion

27 octobre 2026. Doc détaillée : https://claude.ai/artifact/SDXw2DbpZPx9Ug69MqMKpx (privée tant qu'elle n'est pas partagée).

## 1. Point de départ : peut-on modifier l'interface terminal ?

Oui, par des **mods** : de petits plugins TypeScript/JSX chargés par Claude Code. Ils peuvent ajouter :

| Élément | Où |
| --- | --- |
| Pane (panneau) | Ancré à côté de la conversation, ou au-dessus du prompt |
| Bande | Au-dessus du prompt |
| Status line | Footer, sous le prompt |
| Toast | Notification en haut à droite |

Un mod ajoute des éléments, il ne réorganise pas toute l'interface.

Placement d'un panneau :
- Ancré à côté de la conversation en plein écran, à partir de 110 colonnes (144 s'il s'ouvre sans qu'on le demande), sur 45 % de la largeur au maximum.
- Sinon, affiché au-dessus du prompt.
- **Testé : il s'ancre à droite.** L'API ne permet pas de choisir le côté.
- Plusieurs panneaux = des onglets (`ctrl+x tab` pour changer, `ctrl+x x` ou `Esc` pour fermer).

## 2. L'idée : un panneau commun, une section par mod

Au lieu que chaque mod ait son panneau ou une ligne dans le footer, un mod hôte `starboard` affiche un panneau unique. Les autres mods y publient leur section (des mini-panneaux empilés et repliables).

```
┌─ Starboard ───────────────────┐
│ ▾ Contexte                  │  ← workspace-info
│   ● branche  feature/PAY-12 │
│     worktree hap-pay-12 (lié)
│     jira     PAY-12         │
│ ▾ Docker                    │  ← hap-stack (à écrire)
│ ▸ Sessions                  │  ← session-link (à migrer)
└─────────────────────────────┘
```

Exemples de sections envisagés : session-link (actuellement dans le footer), branche / worktree / ticket Jira, état des conteneurs Docker de la stack HAP du worktree.

## 3. Comment ça marche

- `starboard` ajoute un objet `$.starboard` à l'API des mods, avec deux méthodes : `publish(section)` et `remove(id)`.
- Chaque appel devient un événement (`starboard.publish`) que l'hôte intercepte pour ranger la section dans son `$.state`. L'écriture redessine le panneau automatiquement.
- **Les sections passent des données, pas des composants** (un argument d'événement doit rester une valeur simple). Conséquence : le graphe interactif de session-link ne peut pas aller tel quel dans le panneau.

Contrat :

| Type | Champs |
| --- | --- |
| `StarboardSection` | `id`, `title`, `order?` (tri, défaut 100), `rows`, `note?` |
| `StarboardRow` | `label?`, `value`, `status?`, `dim?` |
| `StarboardStatus` | `ok` (vert), `warn` (jaune), `error` (rouge), `off` (vide) |

## 4. Starboard facultatif

Demande : un mod doit fonctionner normalement si l'utilisateur n'a pas `starboard`.

- `plugin.json` ne propose pas de dépendance optionnelle (une dépendance déclarée est obligatoire). Le mod de section ne déclare donc **pas** `starboard`.
- Il copie le contrat en local, appelle `$.starboard.publish(...)` dans un `try`, et dans le `catch` utilise son affichage de base (footer, bande ou panneau dédié).
- Le validateur refuse `if ($.starboard)` ou `const s = $.starboard` : il faut appeler la méthode directement.
- Le coût : si le contrat de `starboard` change, les copies locales doivent être mises à jour à la main. Règle proposée : n'ajouter que des champs optionnels, et passer à une version majeure pour tout changement cassant.

```ts
import type { EngineInterface as Engine, Register } from 'claude-code'

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    $.clock.every(15000, () => refresh($))
    return next(e)
  })
}
```

## 5. Le prototype

| Mod | Rôle | État |
| --- | --- | --- |
| `starboard` | Hôte : `$.starboard`, panneau, commande `/starboard`, repli des sections | Validé, chargé et vu en session (à droite) |
| `workspace-info` | Section « Contexte » : branche (jaune si modifs non commitées), worktree (« lié » si secondaire), ticket Jira tiré du nom de branche ; rafraîchi toutes les 15 s ; footer si pas de starboard | Validé ; cas sans starboard couvert par un test |

## 6. Partager les mods

1. Publier `starboard` (bibliothèque de l'organisation, ou dépôt GitHub).
2. Chacun installe `starboard` s'il le souhaite.
3. Chaque auteur branche son mod avec le schéma `try`/`catch` ci-dessus, sans dépendance.
4. Il publie son mod ; ceux qui ont `starboard` voient la section dans le panneau, les autres l'affichage de base.

Par GitHub : un fichier `.claude-plugin/marketplace.json` dans le dépôt, puis l'installation par :

```
/plugin install <mod> --marketplace <owner>/<repo>
```

Règles proposées pour les contributeurs :

| Règle | Proposition |
| --- | --- |
| `id` de section | Le nom du mod, unique |
| `order` | 0–19 contexte, 20–39 infra, 40–59 collaboration, 100 par défaut |
| Rafraîchissement | 10 s minimum pour une commande externe |
| Taille | 8 lignes maximum par section |

## 7. Reste à faire

- [x] Vérifier que `starboard.publish` passe par le hook de l'hôte
- [x] Voir de quel côté le panneau s'ancre : à droite
- [ ] Faire suivre à workspace-info le dossier où Claude travaille, pas seulement celui de la session
- [ ] Section Docker (`docker ps --filter name=hap-<branche>`)
- [ ] Migrer session-link : résumé dans le panneau, graphe dans son propre panneau
- [ ] Récupérer le titre du ticket Jira
- [x] Publier sur GitHub : github.com/GabrielBlondeau-Kirby/starboard
