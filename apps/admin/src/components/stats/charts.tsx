'use client'

import { useState } from 'react'
import { formatDay, formatNumber } from '@/lib/format'

/**
 * Histogramme d'une série par jour (SVG, une seule série, sans dépendance). Le survol ou le
 * focus clavier d'une barre affiche sa valeur au-dessus du graphique.
 */
export function DailyBars({
  points,
  unit,
}: {
  points: { date: string; count: number }[]
  unit: [singular: string, plural: string]
}) {
  const [hovered, setHovered] = useState<number | null>(null)
  const max = Math.max(1, ...points.map((point) => point.count))
  const width = Math.max(points.length, 1)
  const active = hovered === null ? undefined : points[hovered]
  const total = points.reduce((sum, point) => sum + point.count, 0)
  const label = (count: number) => `${formatNumber(count)} ${count > 1 ? unit[1] : unit[0]}`

  return (
    <figure>
      <p className="mb-2 h-5 text-sm text-muted-foreground" aria-live="polite">
        {active
          ? `${formatDay(active.date)} : ${label(active.count)}`
          : `Max. ${label(max)} par jour`}
      </p>
      <svg
        viewBox={`0 0 ${String(width)} 100`}
        preserveAspectRatio="none"
        className="h-40 w-full"
        role="img"
        aria-label={`${label(total)} sur ${String(points.length)} jours`}
        onMouseLeave={() => {
          setHovered(null)
        }}
      >
        <line
          x1="0"
          x2={width}
          y1="100"
          y2="100"
          className="stroke-border"
          strokeWidth="0.5"
          vectorEffect="non-scaling-stroke"
        />
        {points.map((point, index) => {
          const height = (point.count / max) * 96
          return (
            <g
              key={point.date}
              onMouseEnter={() => {
                setHovered(index)
              }}
            >
              {/* Zone de survol pleine hauteur, plus large que la barre. */}
              <rect x={index} y="0" width="1" height="100" fill="transparent" />
              <rect
                x={index + 0.15}
                y={100 - height}
                width="0.7"
                height={height}
                className={hovered === index ? 'fill-foreground' : 'fill-chart-1'}
              />
            </g>
          )
        })}
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{points[0] ? formatDay(points[0].date) : ''}</span>
        <span>{points.at(-1) ? formatDay(points.at(-1)?.date ?? '') : ''}</span>
      </figcaption>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Voir les données</summary>
        <table className="mt-2 w-full max-w-sm text-left">
          <tbody className="divide-y">
            {points.map((point) => (
              <tr key={point.date}>
                <td className="py-1">{formatDay(point.date)}</td>
                <td className="py-1 text-right tabular-nums">{formatNumber(point.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}

/** Barres horizontales (CSS) : libellé, barre proportionnelle, valeur. */
export function HorizontalBars({
  rows,
}: {
  rows: { label: string; value: number; display: string }[]
}) {
  const max = Math.max(1, ...rows.map((row) => row.value))
  return (
    <ul className="grid gap-2">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[9rem_1fr_6rem] items-center gap-3 text-sm">
          <span className="truncate text-muted-foreground">{row.label}</span>
          <span className="h-3 overflow-hidden rounded-sm bg-muted" aria-hidden>
            <span
              className="block h-full rounded-sm bg-chart-1"
              style={{ width: `${String((row.value / max) * 100)}%` }}
            />
          </span>
          <span className="text-right tabular-nums">{row.display}</span>
        </li>
      ))}
    </ul>
  )
}
