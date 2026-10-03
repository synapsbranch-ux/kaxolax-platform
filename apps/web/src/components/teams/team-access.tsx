'use client'

import { type TeamMemberRole, teamMemberRoleSchema } from '@kaxolax/contracts'
import { Label, NativeSelect } from '@kaxolax/ui'
import { UsersIcon } from 'lucide-react'
import { TEAM_ROLE_LABELS, teamAccessText } from '@/lib/teams'

/**
 * Accès d'équipe d'un projet de workspace d'équipe, dans la modale de partage : qui y accède, et
 * pour qui peut gérer les membres (propriétaire, administrateur de l'équipe), le rôle des membres
 * de l'équipe sur ce projet (`PUT /projects/:id/team-access`).
 */
export function TeamAccess({
  team,
  canManage,
  busy,
  onChange,
}: {
  team: { name: string; memberRole: TeamMemberRole; memberCount: number }
  canManage: boolean
  busy: boolean
  onChange: (role: TeamMemberRole) => void
}) {
  return (
    <section
      className="flex flex-col gap-2 rounded-md border p-3 text-sm"
      aria-label="Accès de l’équipe"
      data-testid="team-access"
    >
      <p className="flex items-start gap-2">
        <UsersIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span>{teamAccessText(team)}</span>
      </p>
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="team-access-role" className="font-normal text-muted-foreground">
            Rôle des membres de l’équipe
          </Label>
          <NativeSelect
            id="team-access-role"
            className="h-8"
            value={team.memberRole}
            disabled={busy}
            onChange={(event) => {
              const role = teamMemberRoleSchema.safeParse(event.target.value)
              if (role.success) onChange(role.data)
            }}
            data-testid="team-access-role"
          >
            {teamMemberRoleSchema.options.map((role) => (
              <option key={role} value={role}>
                {TEAM_ROLE_LABELS[role]}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
    </section>
  )
}
