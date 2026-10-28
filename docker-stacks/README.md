# docker-stacks

Les stacks Docker Compose actives et leur mémoire, avec une alerte quand la VM Docker approche de la saturation : section « Docker » dans starboard s'il est installé, sinon dans le footer (seulement en cas d'alerte).

Pourquoi : quand la VM Docker manque de mémoire, les conteneurs sont tués (`rc=137`) sans que rien ne dise quelle stack oubliée prend la place.

## Installation

```
/plugin install docker-stacks --marketplace GabrielBlondeau-Kirby/starboard
```

## Fonctionnement

- Une ligne par projet Compose suivi : mémoire et nombre de conteneurs, la plus grosse en premier. Puis `autres` (ce qui tourne hors filtre) et `total` : mémoire utilisée sur la mémoire de la VM Docker.
- `total` passe en orange au-delà du seuil d'alerte, en rouge à 95 %. Au franchissement du seuil, une notification nomme la plus grosse stack.
- Rafraîchi toutes les 30 s ; `/docker` rafraîchit tout de suite et donne le détail.
- Docker arrêté ou absent : « Docker indisponible », sans erreur.

## Options

Dans `/config` (une ligne par option), ou à l'installation :

| Option | Défaut | Rôle |
| --- | --- | --- |
| `prefixes` | vide | Préfixes des stacks à suivre, séparés par des virgules (ex. `shop-, api-`). Une stack est suivie si le nom de son projet Compose ou d'un de ses conteneurs commence par l'un d'eux. Vide : toutes les stacks, y compris les conteneurs hors Compose. |
| `warnPercent` | `80` | Part de la mémoire de la VM Docker au-delà de laquelle la section passe en alerte. |
