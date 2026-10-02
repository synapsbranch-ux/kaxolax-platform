'use client'

import type * as React from 'react'
import { useState } from 'react'
import { initialsOf, splitAvatarStack } from '../lib/avatars.js'
import { cn } from '../utils.js'
import { Avatar, AvatarFallback, AvatarImage, type AvatarSize, avatarVariants } from './avatar.js'
import { Popover, PopoverContent, PopoverTrigger } from './popover.js'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.js'

type StyleWithVariables = React.CSSProperties & Partial<Record<`--${string}`, string>>

/** Couleur de séparation entre avatars superposés : `--avatar-stack-ring` (fond de la zone). */
const SEPARATION_RING = 'var(--avatar-stack-ring, var(--background))'
const separationStyle: StyleWithVariables = { '--avatar-ring': SEPARATION_RING }

/**
 * Avatar d'une personne : photo, sinon initiales. Avec `color` (couleur de présence), un anneau
 * de cette couleur et des initiales sur ce fond.
 */
export function PresenceAvatar({
  name,
  imageUrl,
  color,
  size,
  ring = color !== undefined,
  className,
  style,
}: {
  name: string
  imageUrl?: string | null
  color?: string
  size?: AvatarSize
  /** Anneau autour de l'avatar : couleur de présence, sinon couleur de séparation. */
  ring?: boolean
  className?: string
  style?: React.CSSProperties
}) {
  const ringStyle: StyleWithVariables = { '--avatar-ring': color ?? SEPARATION_RING, ...style }
  return (
    <Avatar
      size={size}
      className={cn(ring && 'ring-2 ring-(color:--avatar-ring)', className)}
      style={ringStyle}
    >
      {imageUrl ? <AvatarImage src={imageUrl} alt="" /> : null}
      <AvatarFallback
        style={color ? { backgroundColor: color, color: 'var(--presence-foreground)' } : undefined}
      >
        {initialsOf(name)}
      </AvatarFallback>
    </Avatar>
  )
}

export interface AvatarStackItem {
  /** Identifiant stable (clé React), en général l'id de l'utilisateur. */
  id: string
  name: string
  imageUrl?: string | null
  /** Couleur CSS de présence (`presenceColor(…)`) : anneau et fond des initiales. */
  color?: string
  /** Détail affiché au survol sous le nom, par exemple le fichier ouvert. */
  description?: string
}

export interface AvatarStackProps extends Omit<React.ComponentProps<'div'>, 'onSelect'> {
  items: readonly AvatarStackItem[]
  /** Nombre de places, pastille « +N » comprise (voir `splitAvatarStack`). */
  max?: number
  size?: AvatarSize
  /** Clic sur un avatar (suivre ce collaborateur). Sans lui, les avatars ne sont pas cliquables. */
  onSelect?: (item: AvatarStackItem) => void
  /** Nom accessible de la pastille de débordement. */
  overflowLabel?: (count: number) => string
}

function describe(item: AvatarStackItem): string {
  return item.description ? `${item.name} — ${item.description}` : item.name
}

function defaultOverflowLabel(count: number): string {
  return `${String(count)} autres personnes`
}

/**
 * Pile d'avatars superposés (collaborateurs en ligne). Au survol : nom et détail ; au-delà de
 * `max`, une pastille « +N » ouvre la liste des autres personnes. Donner un `aria-label` à la pile.
 */
export function AvatarStack({
  items,
  max = 4,
  size = 'sm',
  onSelect,
  overflowLabel = defaultOverflowLabel,
  className,
  ...props
}: AvatarStackProps) {
  const [overflowOpen, setOverflowOpen] = useState(false)
  const { visible, overflow } = splitAvatarStack(items, max)
  if (items.length === 0) return null

  return (
    // Fournisseur local : la pile fonctionne aussi sans TooltipProvider global.
    <TooltipProvider delayDuration={200}>
      <div
        data-slot="avatar-stack"
        role="group"
        className={cn('flex items-center -space-x-1.5', className)}
        {...props}
      >
        {visible.map((item) => (
          <Tooltip key={item.id}>
            <TooltipTrigger asChild>
              {onSelect ? (
                <button
                  type="button"
                  aria-label={describe(item)}
                  className="relative rounded-full outline-none hover:z-10 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  onClick={() => {
                    onSelect(item)
                  }}
                >
                  <PresenceAvatar
                    name={item.name}
                    imageUrl={item.imageUrl}
                    color={item.color}
                    size={size}
                    ring
                  />
                </button>
              ) : (
                <span role="img" aria-label={describe(item)} className="relative rounded-full">
                  <PresenceAvatar
                    name={item.name}
                    imageUrl={item.imageUrl}
                    color={item.color}
                    size={size}
                    ring
                  />
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent>
              <span className="flex flex-col">
                <span className="font-medium">{item.name}</span>
                {item.description ? <span className="opacity-80">{item.description}</span> : null}
              </span>
            </TooltipContent>
          </Tooltip>
        ))}
        {overflow.length > 0 ? (
          <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={overflowLabel(overflow.length)}
                data-slot="avatar-stack-overflow"
                className={cn(
                  avatarVariants({ size }),
                  'relative items-center justify-center bg-muted font-medium text-muted-foreground ring-2 ring-(color:--avatar-ring) outline-none hover:z-10 hover:bg-accent hover:text-accent-foreground focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                )}
                style={separationStyle}
              >
                +{overflow.length}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-1">
              <ul className="flex max-h-72 flex-col overflow-y-auto">
                {overflow.map((item) => {
                  const content = (
                    <>
                      <PresenceAvatar
                        name={item.name}
                        imageUrl={item.imageUrl}
                        color={item.color}
                        size="sm"
                      />
                      <span className="flex min-w-0 flex-col text-left">
                        <span className="truncate text-sm font-medium">{item.name}</span>
                        {item.description ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {item.description}
                          </span>
                        ) : null}
                      </span>
                    </>
                  )
                  const rowClass = 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5'
                  return (
                    <li key={item.id}>
                      {onSelect ? (
                        <button
                          type="button"
                          className={cn(
                            rowClass,
                            'outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                          )}
                          onClick={() => {
                            setOverflowOpen(false)
                            onSelect(item)
                          }}
                        >
                          {content}
                        </button>
                      ) : (
                        <div className={rowClass}>{content}</div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </TooltipProvider>
  )
}
