'use client'

import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react'
import { Menubar as MenubarPrimitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../utils.js'
import { useShortcutText } from './kbd.js'
import {
  menuContentClass,
  menuIndicatorClass,
  menuIndicatorItemClass,
  menuItemClass,
  menuLabelClass,
  menuSeparatorClass,
  menuShortcutClass,
  menuSubTriggerClass,
} from './menu-styles.js'

/**
 * Barre de menus (barre Tools : File, Format, Structures…) : les flèches passent d'un menu à
 * l'autre, comme dans une application de bureau.
 */
export function Menubar({
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Root>) {
  return (
    <MenubarPrimitive.Root
      data-slot="menubar"
      className={cn('flex items-center gap-0.5', className)}
      {...props}
    />
  )
}

export function MenubarMenu(props: React.ComponentProps<typeof MenubarPrimitive.Menu>) {
  return <MenubarPrimitive.Menu {...props} />
}

export const MenubarGroup = MenubarPrimitive.Group
export const MenubarPortal = MenubarPrimitive.Portal
export const MenubarRadioGroup = MenubarPrimitive.RadioGroup
export const MenubarSub = MenubarPrimitive.Sub

export function MenubarTrigger({
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Trigger>) {
  return (
    <MenubarPrimitive.Trigger
      data-slot="menubar-trigger"
      className={cn(
        "flex h-7 select-none items-center gap-1.5 rounded-sm px-2 text-sm font-medium outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

export function MenubarContent({
  className,
  align = 'start',
  alignOffset = -4,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Content>) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.Content
        data-slot="menubar-content"
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        className={cn(
          menuContentClass,
          'min-w-[12rem] max-h-(--radix-menubar-content-available-height) origin-(--radix-menubar-content-transform-origin)',
          className,
        )}
        {...props}
      />
    </MenubarPrimitive.Portal>
  )
}

export function MenubarItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Item> & {
  /** Aligne le texte sur les éléments qui ont une coche ou une icône. */
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <MenubarPrimitive.Item
      data-slot="menubar-item"
      data-inset={inset ? '' : undefined}
      data-variant={variant}
      className={cn(menuItemClass, className)}
      {...props}
    />
  )
}

export function MenubarCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.CheckboxItem>) {
  return (
    <MenubarPrimitive.CheckboxItem
      data-slot="menubar-checkbox-item"
      className={cn(menuIndicatorItemClass, className)}
      {...props}
    >
      <span className={menuIndicatorClass}>
        <MenubarPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </MenubarPrimitive.ItemIndicator>
      </span>
      {children}
    </MenubarPrimitive.CheckboxItem>
  )
}

export function MenubarRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.RadioItem>) {
  return (
    <MenubarPrimitive.RadioItem
      data-slot="menubar-radio-item"
      className={cn(menuIndicatorItemClass, className)}
      {...props}
    >
      <span className={menuIndicatorClass}>
        <MenubarPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </MenubarPrimitive.ItemIndicator>
      </span>
      {children}
    </MenubarPrimitive.RadioItem>
  )
}

export function MenubarLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Label> & { inset?: boolean }) {
  return (
    <MenubarPrimitive.Label
      data-slot="menubar-label"
      data-inset={inset ? '' : undefined}
      className={cn(menuLabelClass, className)}
      {...props}
    />
  )
}

export function MenubarSeparator({
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Separator>) {
  return (
    <MenubarPrimitive.Separator
      data-slot="menubar-separator"
      className={cn(menuSeparatorClass, className)}
      {...props}
    />
  )
}

/** Raccourci d'un élément : `shortcut` au format CodeMirror, ou texte en enfant. */
export function MenubarShortcut({
  className,
  shortcut,
  children,
  ...props
}: React.ComponentProps<'span'> & { shortcut?: string }) {
  const text = useShortcutText(shortcut)
  return (
    <span data-slot="menubar-shortcut" className={cn(menuShortcutClass, className)} {...props}>
      {text ?? children}
    </span>
  )
}

export function MenubarSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <MenubarPrimitive.SubTrigger
      data-slot="menubar-sub-trigger"
      data-inset={inset ? '' : undefined}
      className={cn(menuSubTriggerClass, className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </MenubarPrimitive.SubTrigger>
  )
}

export function MenubarSubContent({
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.SubContent>) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.SubContent
        data-slot="menubar-sub-content"
        className={cn(
          menuContentClass,
          'max-h-(--radix-menubar-content-available-height) origin-(--radix-menubar-content-transform-origin) shadow-lg',
          className,
        )}
        {...props}
      />
    </MenubarPrimitive.Portal>
  )
}
