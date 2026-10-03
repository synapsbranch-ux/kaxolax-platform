import { OrganizationsScreen } from '@/components/organizations/organizations-screen'
import { pageParam, param } from '@/lib/search-params'

export default async function OrganizationsPage({ searchParams }: PageProps<'/organizations'>) {
  const query = await searchParams
  const q = param(query.q)
  const page = pageParam(query.page)
  return <OrganizationsScreen key={`${q}|${String(page)}`} q={q} page={page} />
}
