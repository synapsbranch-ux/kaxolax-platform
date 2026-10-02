'use client'

import { useParams } from 'next/navigation'
import { WorkspacePage } from '@/components/workspace/workspace-page'

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>()
  return <WorkspacePage key={id} projectId={id} />
}
