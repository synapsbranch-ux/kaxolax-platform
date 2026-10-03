'use client'

import { UserProfile } from '@clerk/nextjs'
import { GaugeIcon, PlugIcon } from 'lucide-react'
import { ZoteroConnection } from '@/components/integrations/zotero-connection'
import { PlanUsage } from './plan-usage'

/**
 * <UserProfile /> de Clerk sur /account : profil, sécurité, facturation (onglet Billing :
 * abonnement, factures, moyens de paiement) et une page « Plan et usage » (/account/plan) qui
 * montre le plan, le stockage utilisé et les limites (`GET /me/plan`), et une page « Intégrations »
 * (/account/integrations) : connexion de Zotero.
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
      {/* Intégrations (étape 3) : connexion des comptes externes, Zotero d'abord. */}
      <UserProfile.Page
        label="Intégrations"
        url="integrations"
        labelIcon={<PlugIcon className="size-4" />}
      >
        <div className="flex flex-col gap-4">
          <h1 className="text-lg font-semibold">Intégrations</h1>
          <ZoteroConnection />
        </div>
      </UserProfile.Page>
    </UserProfile>
  )
}
