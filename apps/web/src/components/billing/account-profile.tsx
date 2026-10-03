'use client'

import { UserProfile } from '@clerk/nextjs'
import { GaugeIcon } from 'lucide-react'
import { PlanUsage } from './plan-usage'

/**
 * <UserProfile /> de Clerk sur /account : profil, sécurité, facturation (onglet Billing :
 * abonnement, factures, moyens de paiement) et une page « Plan et usage » (/account/plan) qui
 * montre le plan, le stockage utilisé et les limites (`GET /me/plan`).
 */
export function AccountProfile() {
  return (
    <UserProfile path="/account" routing="path">
      {/* Pages de Clerk dans leur ordre (Billing selon l'instance), puis celle-ci. */}
      <UserProfile.Page
        label="Plan et usage"
        url="plan"
        labelIcon={<GaugeIcon className="size-4" />}
      >
        <div className="flex flex-col gap-4">
          <h1 className="text-lg font-semibold">Plan et usage</h1>
          <PlanUsage />
        </div>
      </UserProfile.Page>
    </UserProfile>
  )
}
