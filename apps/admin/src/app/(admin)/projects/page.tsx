import { ADMIN_PROJECT_VIEWS, type AdminProjectView } from '@kaxolax/contracts'
import { ProjectsScreen } from '@/components/projects/projects-screen'
import { pageParam, param } from '@/lib/search-params'

function viewParam(value: string): AdminProjectView {
  return ADMIN_PROJECT_VIEWS.find((view) => view === value) ?? 'all'
}

export default async function ProjectsPage({ searchParams }: PageProps<'/projects'>) {
  const query = await searchParams
  const q = param(query.q)
  const view = viewParam(param(query.view))
  const page = pageParam(query.page)
  return <ProjectsScreen key={`${q}|${view}|${String(page)}`} q={q} view={view} page={page} />
}
