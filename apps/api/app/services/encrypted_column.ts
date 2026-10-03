import encryption from '@adonisjs/core/services/encryption'

/**
 * Options d'une colonne Lucid chiffrée au repos (encryption d'AdonisJS : AES-256-GCM avec
 * `APP_KEY`). `purpose` lie le texte chiffré à sa colonne : recopié dans une autre colonne, il ne
 * se déchiffre pas. Un texte illisible (clé changée sans garder l'ancienne dans
 * `config/encryption.ts`) se lit `null` : le jeton est à redemander. Jamais sérialisée.
 */
export function encryptedColumn(purpose: string) {
  return {
    prepare: (value: string | null) =>
      value === null ? null : encryption.encrypt(value, undefined, purpose),
    consume: (value: string | null) =>
      value === null ? null : encryption.decrypt<string>(value, purpose),
    serializeAs: null,
  }
}
