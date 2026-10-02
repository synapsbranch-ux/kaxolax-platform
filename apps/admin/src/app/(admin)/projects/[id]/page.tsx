import { ProjectScreen } from '@/components/projects/project-screen'

export default async function ProjectPage({ params }: PageProps<'/projects/[id]'>) {
  const { id } = await params
  return <ProjectScreen key={id} projectId={id} />
}
