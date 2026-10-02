import { UserScreen } from '@/components/users/user-screen'

export default async function UserPage({ params }: PageProps<'/users/[id]'>) {
  const { id } = await params
  return <UserScreen key={id} userId={id} />
}
