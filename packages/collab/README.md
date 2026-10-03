# @kaxolax/collab

Conventions Yjs de Kaxolax, partagées par l'API (`apps/api`), le service temps réel
(`apps/realtime`) et l'éditeur (`apps/web`) : chaque document texte est un `Y.Doc` qui contient un
seul `Y.Text` nommé `content` (`TEXT_FIELD`).

| Module       | Contenu                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`   | Noms des documents Hocuspocus (`project:{id}:doc:{documentId}`, document meta `project:{id}:meta`) et leur analyse ; lecture, création et remplacement du texte d'un état Yjs persisté |
| `anchors.ts` | Ancres des commentaires : plage décrite par deux positions relatives Yjs, format binaire versionné, base64                                                                             |
| `history.ts` | Historique : rejeu des mises à jour journalisées avec leur auteur, diff attribué, remplacement minimal                                                                                 |
| `token.ts`   | Jeton de connexion temps réel (`v1.<charge>.<HMAC-SHA256>`), signé par l'API, vérifié par realtime                                                                                     |

`token.ts` utilise `node:crypto` : il n'est exporté que par `@kaxolax/collab/token` (Node.js), pas
par l'entrée principale, que le navigateur importe. Les schémas des messages (claims du jeton,
événements, présence) sont dans `@kaxolax/contracts`.

```bash
pnpm --filter @kaxolax/collab build
pnpm --filter @kaxolax/collab test
```
