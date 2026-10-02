import { UsersScreen } from '@/components/users/users-screen'
import { pageParam, param } from '@/lib/search-params'

export default async function UsersPage({ searchParams }: PageProps<'/users'>) {
  const query = await searchParams
  const q = param(query.q)
  const page = pageParam(query.page)
  return <UsersScreen key={`${q}|${String(page)}`} q={q} page={page} />
}
