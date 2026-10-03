import { OrganizationScreen } from '@/components/organizations/organization-screen'

export default async function OrganizationPage({ params }: PageProps<'/organizations/[id]'>) {
  const { id } = await params
  return <OrganizationScreen key={id} organizationId={decodeURIComponent(id)} />
}
