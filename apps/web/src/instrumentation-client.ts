import { z } from 'zod'

/**
 * Exécuté par Next.js dans le navigateur avant le code de l'application : zod sans compilation de
 * ses validateurs (`Function`). La CSP des pages interdit l'eval JavaScript ; sans ce réglage, la
 * détection de zod, faite à la création des schémas, déclencherait un rapport de violation à
 * chaque page. Les validations restent identiques, simplement interprétées.
 */
z.config({ jitless: true })
