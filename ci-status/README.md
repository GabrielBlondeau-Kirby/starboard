# ci-status

État de la CI Azure DevOps de la branche courante : section « CI » dans starboard s'il est installé, sinon dans le footer.

## Installation

```
/plugin install ci-status --marketplace GabrielBlondeau-Kirby/starboard
```

## Fonctionnement

- Lit l'organisation, le projet et le dépôt dans le remote `origin` (`dev.azure.com`, `ssh.dev.azure.com`, `*.visualstudio.com`). Hors Azure DevOps, le mod ne montre rien.
- Cherche la PR active de la branche et suit les builds de `refs/pull/<id>/merge` (sinon ceux de la branche), un par pipeline pour le dernier commit, avec les étapes en échec.
- Rafraîchit toutes les 60 s. `/ci` rafraîchit tout de suite, `/ci off` et `/ci on` coupent et relancent le suivi.

## PAT Azure DevOps

Lu dans la variable d'environnement `AZURE_ACCESS_TOKEN`, sinon dans `docker/.env` à la racine du worktree ou du dépôt principal. Droits nécessaires : *Code (Read)* et *Build (Read)*. Le PAT ne sort que dans l'en-tête `Authorization` des appels à `dev.azure.com`.
