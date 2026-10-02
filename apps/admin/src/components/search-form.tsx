'use client'

import { Button, Input } from '@kaxolax/ui'
import { Search } from 'lucide-react'
import { useState } from 'react'

/** Champ de recherche validé par Entrée ou par le bouton. */
export function SearchForm({
  initial,
  placeholder,
  onSearch,
}: {
  initial: string
  placeholder: string
  onSearch: (q: string) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <form
      role="search"
      className="flex w-full max-w-md gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSearch(value.trim())
      }}
    >
      <Input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => {
          setValue(event.target.value)
        }}
      />
      <Button type="submit" variant="secondary">
        <Search aria-hidden />
        Rechercher
      </Button>
    </form>
  )
}
