import { Input, Label } from '@kaxolax/ui'
import type * as React from 'react'

export function Field({
  label,
  id,
  ...props
}: React.ComponentProps<'input'> & { label: string; id: string }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} {...props} />
    </div>
  )
}
