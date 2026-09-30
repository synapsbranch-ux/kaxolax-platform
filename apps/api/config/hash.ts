import { defineConfig, drivers } from '@adonisjs/core/hash'

/** scrypt (natif Node.js) : aucune dépendance compilée, résistant aux attaques par force brute. */
const hashConfig = defineConfig({
  default: 'scrypt',
  list: {
    scrypt: drivers.scrypt({ cost: 16384, blockSize: 8, parallelization: 1, maxMemory: 33554432 }),
  },
})

export default hashConfig

declare module '@adonisjs/core/types' {
  export interface HashersList extends InferHashers<typeof hashConfig> {}
}
