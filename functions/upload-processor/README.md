# @kaxolax/upload-processor

`processUpload()` vérifie un objet uploadé par URL présignée : présence, taille annoncée, plafond.
Il calcule ensuite son sha256 et le classe : document texte (extension texte, moins de 2 Mo, UTF-8
valide) ou fichier binaire (type MIME déduit de l'extension). La fonction ne modifie rien :
l'appelant crée le document ou le fichier, puis supprime ou déplace l'objet.

L'API l'appelle dans son propre processus, avec son client S3 (R2 en production), en local
comme en production. `handler` (export `./handler`), un handler au format AWS Lambda écrit à
l'étape 1, **n'est pas déployé** : la production tourne sur Railway et Cloudflare, sans
fonctions Lambda, et rien ne l'appelle.

```bash
pnpm --filter @kaxolax/upload-processor test
```
