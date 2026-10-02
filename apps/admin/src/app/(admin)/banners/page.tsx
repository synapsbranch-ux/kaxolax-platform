import { BannersScreen } from '@/components/banners/banners-screen'
import { pageParam } from '@/lib/search-params'

export default async function BannersPage({ searchParams }: PageProps<'/banners'>) {
  const page = pageParam((await searchParams).page)
  return <BannersScreen key={String(page)} page={page} />
}
