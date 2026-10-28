# navi

> *Hey, listen!* : la fée de Link, qui interpelle au bon moment.

Un panneau qui liste les sessions Claude Code ouvertes sur la machine, montre qui a déjà échangé avec qui (SendMessage), et permet de mettre deux sessions en relation par glisser-déposer.

## Installation

```
/plugin install navi --marketplace GabrielBlondeau-Kirby/starboard
```

## Utilisation

- `/navi` ouvre le panneau « Sessions ».
- `/navi cut <session>` coupe la connexion avec une session ; dans le panneau, `x` coupe celle de la session sous le curseur.
- `/navi cut-all` coupe toutes les connexions de cette session.
  Une coupure masque les échanges passés de la paire ; un nouveau message ou une nouvelle mise en relation recrée le lien. L'autre session n'est pas prévenue.
- Avec [starboard](../README.md), une section « Sessions » montre `🌐` cette session et `🔗` chaque session liée (orange si elle est occupée).
- Glisser une session sur une autre (ou ↑↓, espace pour la source, entrée pour la cible) : chacune reçoit un message lui demandant de contacter l'autre par SendMessage.
- En tapant les 3 premières lettres d'une session dans le prompt, l'autocomplétion propose son nom, les sessions liées en premier.
- En bas à droite du prompt, `🌐 <nom de la session>` donne le nom à utiliser avec SendMessage, et en dessous `🔗 <session>` pour chaque session liée.

## Limites

- Une session ne voit que les messages qu'elle envoie : les échanges entre deux autres sessions n'apparaissent que si elles ont aussi le mod.
- Les réponses adressées au socket (`uds:…`) ne sont pas rattachées à un nom et ne sont pas affichées.
- Le glisser-déposer suppose que le terminal transmet la souris ; le clavier marche toujours.
- L'API des mods Claude Code est en accès anticipé et peut changer d'une version à l'autre.
