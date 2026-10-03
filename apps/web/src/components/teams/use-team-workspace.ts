'use client'

import { useAuth, useClerk } from '@clerk/nextjs'
import type { Workspace } from '@kaxolax/contracts'
import { useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/api'

/** Intervalle entre deux lectures pendant la synchronisation d'une équipe. */
const POLL_MS = 2_000
/** Durée maximale d'attente de la synchronisation (webhook ou rattrapage). */
const SYNC_TIMEOUT_MS = 60_000

export type TeamWorkspaceState =
  /** Activation de l'organisation dans la session, ou première lecture. */
  | { status: 'loading' }
  /** Organisation active, workspace local pas encore créé (webhook en route). */
  | { status: 'syncing' }
  | { status: 'ready'; workspace: Workspace }
  /** Pas (ou plus) membre de l'organisation, ou synchronisation trop longue. */
  | { status: 'missing'; reason: 'not-member' | 'timeout' }

/**
 * Workspace d'équipe d'une organisation Clerk : l'organisation devient l'organisation active de
 * la session (`setActive`, refusé par Clerk à un non-membre ; claims `o` et plan d'organisation du
 * jeton), puis son workspace est lu dans `GET /workspaces`. Juste après la création d'une équipe
 * ou l'acceptation d'une invitation, le webhook Clerk peut ne pas être encore arrivé :
 * `POST /workspaces/sync` rattrape alors l'organisation depuis l'API Backend de Clerk, et la
 * lecture est répétée toutes les 2 s, une minute au plus.
 */
export function useTeamWorkspace(clerkOrganizationId: string): TeamWorkspaceState {
  const { isLoaded, orgId } = useAuth()
  const { setActive } = useClerk()
  const [state, setState] = useState<TeamWorkspaceState>({ status: 'loading' })
  const active = isLoaded && orgId === clerkOrganizationId

  useEffect(() => {
    if (!isLoaded || active) return
    let cancelled = false
    setActive({ organization: clerkOrganizationId }).catch(() => {
      if (!cancelled) setState({ status: 'missing', reason: 'not-member' })
    })
    return () => {
      cancelled = true
    }
  }, [isLoaded, active, clerkOrganizationId, setActive])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = Date.now() + SYNC_TIMEOUT_MS
    const find = (workspaces: readonly Workspace[]) =>
      workspaces.find((workspace) => workspace.clerkOrganizationId === clerkOrganizationId)

    const attempt = async () => {
      let found = find((await api.workspaces()).workspaces)
      if (found === undefined) {
        if (!cancelled) setState({ status: 'syncing' })
        try {
          found = (await api.syncWorkspace()).workspace ?? undefined
        } catch (error) {
          // Rattrapage indisponible (Clerk injoignable) : le webhook peut encore arriver.
          if (!(error instanceof ApiError)) throw error
        }
      }
      if (cancelled) return
      if (found !== undefined) {
        setState({ status: 'ready', workspace: found })
      } else if (Date.now() >= deadline) {
        setState({ status: 'missing', reason: 'timeout' })
      } else {
        timer = setTimeout(() => void attempt().catch(retry), POLL_MS)
      }
    }
    const retry = () => {
      if (cancelled) return
      if (Date.now() >= deadline) setState({ status: 'missing', reason: 'timeout' })
      else timer = setTimeout(() => void attempt().catch(retry), POLL_MS)
    }
    void attempt().catch(retry)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [active, clerkOrganizationId])

  return state
}
