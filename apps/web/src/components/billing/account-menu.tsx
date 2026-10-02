'use client'

import { UserButton } from '@clerk/nextjs'
import { CreditCardIcon } from 'lucide-react'

/**
 * Menu du compte (UserButton de Clerk) : profil, sécurité et facturation (pages de /account, dont
 * l'onglet Billing de <UserProfile />), lien vers la page de tarifs, déconnexion.
 */
export function AccountMenu() {
  return (
    <UserButton userProfileUrl="/account" userProfileMode="navigation">
      <UserButton.MenuItems>
        <UserButton.Link
          label="Tarifs"
          labelIcon={<CreditCardIcon className="size-4" />}
          href="/pricing"
        />
      </UserButton.MenuItems>
    </UserButton>
  )
}
