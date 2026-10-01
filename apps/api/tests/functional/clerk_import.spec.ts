import { randomUUID, scryptSync } from 'node:crypto'
import hash from '@adonisjs/core/services/hash'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import User from '#models/user'
import {
  type ClerkAccount,
  type ClerkAdminApi,
  importUsers,
  type NewClerkAccount,
  probePasswordFormat,
  splitName,
  werkzeugDigest,
} from '#services/clerk_import'
import { createUser } from '#tests/helpers'

/** API Backend de Clerk en mémoire, avec les mêmes règles d'unicité (external_id, email). */
class FakeClerk implements ClerkAdminApi {
  accounts: (NewClerkAccount & ClerkAccount)[] = []
  /** Formats de digest que ce faux Clerk sait vérifier. */
  constructor(private readonly acceptsDigest = false) {}

  findUser(query: { externalId: string } | { email: string }) {
    const found = this.accounts.find((account) =>
      'externalId' in query
        ? account.externalId === query.externalId
        : account.email === query.email,
    )
    return Promise.resolve(found ? { id: found.id } : null)
  }

  createUser(account: NewClerkAccount) {
    if (this.accounts.some((other) => other.email === account.email)) {
      return Promise.reject(new Error('email taken'))
    }
    const created = { ...account, id: `user_${randomUUID().replaceAll('-', '')}` }
    this.accounts.push(created)
    return Promise.resolve({ id: created.id })
  }

  /** Vérifie un digest Werkzeug comme Werkzeug : sel pris comme texte, hash en hexadécimal. */
  verifyPassword(userId: string, password: string) {
    const digest = this.accounts.find((account) => account.id === userId)?.passwordDigest
    const match = digest ? /^scrypt:(\d+):(\d+):(\d+)\$([^$]+)\$([0-9a-f]+)$/.exec(digest) : null
    if (!this.acceptsDigest || !match) return Promise.resolve(false)
    const [, n, r, p, salt, expected] = match as unknown as string[]
    const actual = scryptSync(password, String(salt), 64, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    }).toString('hex')
    return Promise.resolve(actual === expected)
  }

  deleteUser(userId: string) {
    this.accounts = this.accounts.filter((account) => account.id !== userId)
    return Promise.resolve()
  }
}

test.group('clerk: import of stage 1 accounts', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('creates, links and is idempotent', async ({ assert }) => {
    const fresh = await createUser()
    const alreadyInClerk = await createUser()
    const unverified = await createUser({ verified: false })
    const clerk = new FakeClerk()
    await clerk.createUser({ externalId: alreadyInClerk.id, email: alreadyInClerk.email })

    const first = await importUsers(clerk)
    assert.includeMembers(first.created, [fresh.email])
    assert.includeMembers(first.linked, [alreadyInClerk.email])
    assert.notInclude([...first.created, ...first.linked], unverified.email)
    assert.lengthOf(first.failed, 0)

    await fresh.refresh()
    await alreadyInClerk.refresh()
    await unverified.refresh()
    const account = clerk.accounts.find((candidate) => candidate.externalId === fresh.id)
    assert.equal(fresh.clerkUserId, account?.id)
    assert.equal(account?.firstName, 'Ada')
    assert.equal(account?.lastName, 'Lovelace')
    assert.isUndefined(account?.passwordDigest)
    assert.isNotNull(alreadyInClerk.clerkUserId)
    assert.isNull(unverified.clerkUserId)

    // Rejouer ne crée rien et ne change aucun lien.
    const count = clerk.accounts.length
    const second = await importUsers(clerk)
    assert.notInclude([...second.created, ...second.linked], fresh.email)
    assert.equal(clerk.accounts.length, count)
    // Le mot de passe local n'est pas touché par l'import.
    assert.isTrue(
      await (await User.findOrFail(fresh.id)).verifyPassword('correct horse battery staple'),
    )
  })

  test('a dry run changes nothing', async ({ assert }) => {
    const user = await createUser()
    const clerk = new FakeClerk()
    const report = await importUsers(clerk, { dryRun: true })
    assert.include(report.created, user.email)
    assert.lengthOf(clerk.accounts, 0)
    await user.refresh()
    assert.isNull(user.clerkUserId)
  })

  test('an account rejected by Clerk is reported and retried on the next run', async ({
    assert,
  }) => {
    const user = await createUser()
    const clerk = new FakeClerk()
    // Email déjà pris dans Clerk par un autre compte (sans le même external_id).
    clerk.accounts.push({ id: 'user_other', externalId: 'elsewhere', email: 'other@example.com' })
    const original = clerk.findUser.bind(clerk)
    clerk.findUser = () => Promise.resolve(null)
    clerk.accounts.push({ id: 'user_dup', externalId: 'x', email: user.email })
    const report = await importUsers(clerk)
    assert.deepInclude(report.failed, { email: user.email, error: 'email taken' })
    await user.refresh()
    assert.isNull(user.clerkUserId)
    clerk.findUser = original
    const retry = await importUsers(clerk)
    assert.include(retry.linked, user.email)
  })

  test('converts AdonisJS scrypt hashes and probes Clerk', async ({ assert }) => {
    const phc = await hash.use('scrypt').make('secret password')
    const digest = werkzeugDigest(phc, 'werkzeug-hex')
    assert.match(String(digest), /^scrypt:16384:8:1\$[^$]+\$[0-9a-f]{128}$/)
    assert.isNull(werkzeugDigest('$bcrypt$v=98$whatever', 'werkzeug-hex'))
    assert.deepEqual(splitName('  Ada   King Lovelace '), {
      firstName: 'Ada',
      lastName: 'King Lovelace',
    })
    assert.deepEqual(splitName(null), {})

    // Un Clerk qui ne vérifie pas ces digests : la sonde le dit et ne laisse aucun compte témoin.
    const refusing = new FakeClerk(false)
    const noWait = () => Promise.resolve()
    const hashWith = (password: string) => hash.use('scrypt').make(password)
    assert.isNull(await probePasswordFormat(refusing, hashWith, noWait))
    assert.lengthOf(refusing.accounts, 0)

    // Même un vérificateur fidèle à Werkzeug (sel pris comme texte) ne retrouve pas le mot de passe :
    // AdonisJS hache avec un sel binaire. D'où la réinitialisation à la première connexion.
    const werkzeug = new FakeClerk(true)
    // Témoin : un vrai digest Werkzeug (sel texte) est bien accepté par ce vérificateur.
    const salt = 'textsalt16chars0'
    const real = scryptSync('pw', salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    const control = await werkzeug.createUser({
      externalId: 'control',
      email: 'control@example.com',
      passwordDigest: `scrypt:16384:8:1$${salt}$${real.toString('hex')}`,
    })
    assert.isTrue(await werkzeug.verifyPassword(control.id, 'pw'))
    await werkzeug.deleteUser(control.id)
    assert.isNull(await probePasswordFormat(werkzeug, hashWith, noWait))
    assert.lengthOf(werkzeug.accounts, 0)
  })
})
