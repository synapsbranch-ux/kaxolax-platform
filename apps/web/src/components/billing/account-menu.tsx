'use client'

import { useAuth, UserButton } from '@clerk/nextjs'
import { PRO_PLAN } from '@kaxolax/contracts'
import { CreditCardIcon, GaugeIcon, SettingsIcon, SparklesIcon } from 'lucide-react'
import { planLabel } from '@/lib/plan-limits'
import { BILLING_URL, PLAN_USAGE_URL, sessionPlan } from '@/lib/plan-usage'

/**
 * Menu du compte (UserButton de Clerk) : profil et sécurité (/account), plan et usage
 * (/account/plan, libellé selon le plan de la session, `has` de Clerk, affichage seulement),
 * facturation (onglet Billing de <UserProfile />), page de tarifs, paramètres de l'éditeur (quand
 * `onOpenSettings` est fourni), déconnexion.
 */
export function AccountMenu({ onOpenSettings }: { onOpenSettings?: () => void } = {}) {
  const { has } = useAuth()
  const plan = planLabel(sessionPlan(has({ plan: PRO_PLAN })))
  return (
    <UserButton userProfileUrl="/account" userProfileMode="navigation">
      <UserButton.MenuItems>
        <UserButton.Link
          label={`Plan ${plan} et usage`}
          labelIcon={<GaugeIcon className="size-4" />}
          href={PLAN_USAGE_URL}
        />
        <UserButton.Link
          label="Facturation"
          labelIcon={<CreditCardIcon className="size-4" />}
          href={BILLING_URL}
        />
        <UserButton.Link
          label="Tarifs"
          labelIcon={<SparklesIcon className="size-4" />}
          href="/pricing"
        />
        {onOpenSettings ? (
          <UserButton.Action
            label="Paramètres de l’éditeur"
            labelIcon={<SettingsIcon className="size-4" />}
            onClick={onOpenSettings}
          />
        ) : null}
      </UserButton.MenuItems>
    </UserButton>
  )
}
