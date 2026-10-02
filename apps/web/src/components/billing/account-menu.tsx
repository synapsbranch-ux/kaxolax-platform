'use client'

import { UserButton } from '@clerk/nextjs'
import { CreditCardIcon, SettingsIcon } from 'lucide-react'

/**
 * Menu du compte (UserButton de Clerk) : profil, sécurité et facturation (pages de /account, dont
 * l'onglet Billing de <UserProfile />), lien vers la page de tarifs, paramètres de l'éditeur
 * (quand `onOpenSettings` est fourni), déconnexion.
 */
export function AccountMenu({ onOpenSettings }: { onOpenSettings?: () => void } = {}) {
  return (
    <UserButton userProfileUrl="/account" userProfileMode="navigation">
      <UserButton.MenuItems>
        <UserButton.Link
          label="Tarifs"
          labelIcon={<CreditCardIcon className="size-4" />}
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
