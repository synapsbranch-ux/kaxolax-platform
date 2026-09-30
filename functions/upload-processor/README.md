# @kaxolax/upload-processor

`processUpload()` vérifie un objet uploadé par URL présignée : présence, taille annoncée, plafond.
Il calcule ensuite son sha256 et le classe : document texte (extension texte, moins de 2 Mo, UTF-8
valide) ou fichier binaire (type MIME déduit de l'extension). La fonction ne modifie rien :
l'appelant crée le document ou le fichier, puis supprime ou déplace l'objet.

À l'étape 1, l'API l'appelle directement. `handler` (export `./handler`) est le handler Lambda
fin des étapes suivantes.

```bash
pnpm --filter @kaxolax/upload-processor test
```
