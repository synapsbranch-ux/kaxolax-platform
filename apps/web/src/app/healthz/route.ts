/** Sonde de disponibilité (CI, conteneurs), publique. */
export function GET() {
  return Response.json({ status: 'ok' })
}
