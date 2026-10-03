import { randomUUID } from 'node:crypto'
import {
  type ClerkBillingItem,
  type ClerkBillingPayer,
  clerkBillingItemSchema,
  clerkBillingSubscriptionSchema,
  FREE_PLAN,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import mail from '@adonisjs/mail/services/main'
import { DateTime } from 'luxon'
import { appUrl } from '#config/app'
import { PaymentPastDueMail, ProWelcomeMail } from '#mails/billing_mails'
import Subscription from '#models/subscription'
import User from '#models/user'

/**
 * Webhooks Billing de Clerk (`subscription.*`, `subscriptionItem.*`) : miroir des éléments
 * d'abonnement dans `subscriptions` (plan, statut, fin de période), pour l'admin, les statistiques,
 * les emails et le repli des droits sans claims. Payeur : un compte, ou une organisation (plan
 * d'équipe `team`, ligne avec `clerk_organization_id`, sans email : la facturation d'une
 * organisation passe par Clerk). L'ordre de livraison n'est pas garanti : chaque
 * ligne garde dans `updated_at` la date Clerk de l'état reflété, et un événement plus ancien ne
 * l'écrase pas. Les événements rejoués sont écartés en amont (clerk_webhook_events).
 */

/** Le payeur n'a pas encore de miroir local (webhook `user.created` pas encore reçu) : Clerk réessaie. */
export class BillingPayerUnknownException extends Exception {
  static override status = 409
  static override code = 'E_BILLING_PAYER_UNKNOWN'
  static override message = 'The payer of this subscription is not known yet, retry later'
}

/** Email dû par une transition (une transition = un email), inscrit dans `billing_mails`. */
export interface BillingMail {
  kind: 'proWelcome' | 'paymentPastDue'
  userId: string
  planName: string
}

/** Statuts Clerk où un plan payant est déjà acquis : y revenir n'est pas un nouvel abonnement. */
const SUBSCRIBED_STATUSES = new Set(['active', 'past_due', 'canceled'])

export function isBillingEvent(type: string): boolean {
  return type.startsWith('subscription.') || type.startsWith('subscriptionItem.')
}

/**
 * Date Clerk d'un événement : `timestamp` de l'enveloppe (millisecondes, identique d'une
 * livraison à l'autre), sinon `updated_at` de l'objet, sinon maintenant.
 */
export function billingEventTime(event: { timestamp?: unknown; data?: unknown }): DateTime {
  if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) {
    return DateTime.fromMillis(event.timestamp, { zone: 'utc' })
  }
  const data = event.data
  if (typeof data === 'object' && data !== null && 'updated_at' in data) {
    const updatedAt = data.updated_at
    if (typeof updatedAt === 'number') return DateTime.fromMillis(updatedAt, { zone: 'utc' })
  }
  return DateTime.utc()
}

/**
 * Emails dus par une transition de statut d'un élément : bienvenue quand un plan payant devient
 * actif sans l'avoir déjà été (une reprise après retard de paiement ou après résiliation n'en
 * déclenche pas), paiement en retard quand il passe en `past_due`.
 */
export function mailsForTransition(
  previous: string | null,
  next: string,
  paid: boolean,
): BillingMail['kind'][] {
  if (!paid || previous === next) return []
  if (next === 'active' && (previous === null || !SUBSCRIBED_STATUSES.has(previous))) {
    return ['proWelcome']
  }
  if (next === 'past_due') return ['paymentPastDue']
  return []
}

function isPaidPlan(slug: string, plan: ClerkBillingItem['plan']): boolean {
  return slug !== FREE_PLAN && plan?.is_default !== true
}

/** Payeur local d'un élément : un compte (`userId`) ou une organisation Clerk. */
type LocalPayer =
  { userId: string; organizationId: null } | { userId: null; organizationId: string }

/**
 * Reflète un élément d'abonnement. Renvoie le statut précédent (null : nouvelle ligne), le plan et
 * le payeur, ou null si l'événement est ignoré (plus ancien que l'état connu, sans payeur, compte
 * supprimé, élément inconnu sans plan). Un payeur organisation n'a pas besoin d'être connu
 * localement : ses droits sont lus par `clerk_organization_id`.
 */
async function applyItem(
  item: ClerkBillingItem,
  payer: ClerkBillingPayer,
  eventAt: DateTime,
  trx: TransactionClientContract,
): Promise<{ previous: string | null; planSlug: string; payer: LocalPayer } | null> {
  const clerkUserId = item.payer?.user_id ?? payer?.user_id
  const organizationId = item.payer?.organization_id ?? payer?.organization_id
  let local: LocalPayer
  // `user_id` et `organization_id` sont tous deux facultatifs dans `BillingPayerJSON` : un payeur
  // qui porte une organisation est un payeur organisation, même s'il nomme aussi le membre qui a
  // souscrit.
  if (organizationId) {
    local = { userId: null, organizationId }
  } else if (clerkUserId) {
    const user = await User.query({ client: trx }).where('clerkUserId', clerkUserId).first()
    if (!user) throw new BillingPayerUnknownException()
    if (user.deletedAt) return null
    local = { userId: user.id, organizationId: null }
  } else {
    logger.info({ itemId: item.id }, 'billing webhook without payer ignored')
    return null
  }

  let row = await Subscription.query({ client: trx })
    .where('clerkSubscriptionItemId', item.id)
    .forUpdate()
    .first()
  const periodEnd =
    typeof item.period_end === 'number'
      ? DateTime.fromMillis(item.period_end, { zone: 'utc' }).toSQL()
      : null
  if (!row) {
    if (!item.plan) {
      logger.warn({ itemId: item.id }, 'billing webhook for an unknown item without plan ignored')
      return null
    }
    const inserted: unknown[] = await trx
      .insertQuery()
      .table('subscriptions')
      .insert({
        id: randomUUID(),
        user_id: local.userId,
        clerk_organization_id: local.organizationId,
        clerk_subscription_item_id: item.id,
        plan_slug: item.plan.slug,
        status: item.status,
        period_end: periodEnd,
        created_at: DateTime.utc().toSQL(),
        updated_at: eventAt.toSQL(),
      })
      .onConflict('clerk_subscription_item_id')
      .ignore()
      .returning('id')
    if (inserted.length > 0) return { previous: null, planSlug: item.plan.slug, payer: local }
    // Insérée entre-temps par un autre événement : traitée comme une mise à jour.
    row = await Subscription.query({ client: trx })
      .where('clerkSubscriptionItemId', item.id)
      .forUpdate()
      .first()
    if (!row) return null
  }
  // État plus récent déjà reflété : un événement en retard ne revient pas en arrière.
  if (row.updatedAt > eventAt) return null
  const planSlug = item.plan?.slug ?? row.planSlug
  await Subscription.query({ client: trx }).where('id', row.id).update({
    userId: local.userId,
    clerkOrganizationId: local.organizationId,
    planSlug,
    status: item.status,
    periodEnd,
    updatedAt: eventAt.toSQL(),
  })
  return { previous: row.status, planSlug, payer: local }
}

/**
 * Applique un événement Billing dans la transaction du webhook ; renvoie les emails à envoyer
 * après validation. Les autres événements Billing (paymentAttempt.*) sont seulement enregistrés.
 */
export async function applyBillingEvent(
  event: { type: string; data: unknown; timestamp?: unknown },
  trx: TransactionClientContract,
): Promise<BillingMail[]> {
  const eventAt = billingEventTime(event)
  let items: ClerkBillingItem[]
  let payer: ClerkBillingPayer = null
  if (event.type.startsWith('subscriptionItem.')) {
    const parsed = clerkBillingItemSchema.safeParse(event.data)
    if (!parsed.success) {
      logger.warn({ type: event.type, issues: parsed.error.issues }, 'billing webhook ignored')
      return []
    }
    items = [parsed.data]
  } else {
    const parsed = clerkBillingSubscriptionSchema.safeParse(event.data)
    if (!parsed.success) {
      logger.warn({ type: event.type, issues: parsed.error.issues }, 'billing webhook ignored')
      return []
    }
    items = parsed.data.items
    payer = parsed.data.payer
  }

  const mails: BillingMail[] = []
  for (const item of items) {
    const applied = await applyItem(item, payer, eventAt, trx)
    // Abonnement d'organisation : pas d'email (Clerk facture et prévient l'organisation).
    const userId = applied?.payer.userId
    if (!applied || !userId) continue
    const paid = isPaidPlan(applied.planSlug, item.plan)
    for (const kind of mailsForTransition(applied.previous, item.status, paid)) {
      mails.push({ kind, userId, planName: item.plan?.name ?? applied.planSlug })
    }
  }
  return mails
}

/**
 * Inscrit les emails d'un événement dans `billing_mails`, dans la transaction qui applique la
 * transition : ils sont envoyés après validation par `deliverBillingMails`.
 */
export async function queueBillingMails(
  eventId: string,
  mails: BillingMail[],
  trx: TransactionClientContract,
): Promise<void> {
  if (mails.length === 0) return
  await trx
    .insertQuery()
    .table('billing_mails')
    .multiInsert(
      mails.map((billing) => ({
        id: randomUUID(),
        event_id: eventId,
        user_id: billing.userId,
        kind: billing.kind,
        plan_name: billing.planName,
      })),
    )
}

interface PendingBillingMail {
  id: string
  user_id: string
  kind: string
  plan_name: string
}

/**
 * Envoie les emails non envoyés d'un événement et les marque envoyés. Chaque ligne est verrouillée
 * pendant son envoi (`SKIP LOCKED` : une livraison concurrente du même événement ne l'envoie pas
 * une seconde fois). Un échec incrémente `attempts` et garde l'erreur. Renvoie false s'il reste
 * un email non envoyé : le webhook répond alors 503 pour que Clerk relivre l'événement.
 */
export async function deliverBillingMails(eventId: string): Promise<boolean> {
  const pending = (await db
    .from('billing_mails')
    .where('event_id', eventId)
    .whereNull('sent_at')
    .select('id')) as { id: string }[]
  let delivered = true
  for (const { id } of pending) {
    const sent = await db.transaction(async (trx) => {
      const row = (await trx
        .from('billing_mails')
        .where('id', id)
        .whereNull('sent_at')
        .forUpdate()
        .skipLocked()
        .select('id', 'user_id', 'kind', 'plan_name')
        .first()) as PendingBillingMail | null
      if (!row) return true // envoyé entre-temps, ou en cours d'envoi par une autre livraison
      const user = await User.query({ client: trx }).where('id', row.user_id).first()
      if (!user || user.deletedAt) {
        await trx.from('billing_mails').where('id', id).delete()
        return true
      }
      const data = {
        to: user.email,
        fullName: user.fullName,
        planName: row.plan_name,
        billingUrl: `${appUrl.replace(/\/$/, '')}/account/billing`,
      }
      try {
        await mail.send(
          row.kind === 'proWelcome' ? new ProWelcomeMail(data) : new PaymentPastDueMail(data),
        )
      } catch (error) {
        logger.error({ err: error, userId: user.id, kind: row.kind }, 'billing email not sent')
        await trx
          .from('billing_mails')
          .where('id', id)
          .update({
            attempts: db.raw('attempts + 1'),
            last_error: error instanceof Error ? error.message.slice(0, 1000) : String(error),
          })
        return false
      }
      await trx
        .from('billing_mails')
        .where('id', id)
        .update({ attempts: db.raw('attempts + 1'), sent_at: DateTime.utc().toSQL() })
      return true
    })
    delivered &&= sent
  }
  return delivered
}
