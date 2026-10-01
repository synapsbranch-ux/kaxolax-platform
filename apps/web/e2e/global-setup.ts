import { clerkSetup } from '@clerk/testing/playwright'

/**
 * Jeton de test Clerk (contourne la protection anti-robots de l'instance de développement). Exige
 * CLERK_PUBLISHABLE_KEY et CLERK_SECRET_KEY de l'instance de développement.
 */
export default async function globalSetup() {
  for (const name of ['CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY']) {
    if (!process.env[name]) {
      throw new Error(
        `${name} is required: the journey signs up through a Clerk development instance`,
      )
    }
  }
  await clerkSetup({ dotenv: false })
}
