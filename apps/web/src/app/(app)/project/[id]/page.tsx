'use client'

import { useParams } from 'next/navigation'
import { EditorPage } from '@/components/editor/editor-page'

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>()
  return <EditorPage key={id} projectId={id} />
}
