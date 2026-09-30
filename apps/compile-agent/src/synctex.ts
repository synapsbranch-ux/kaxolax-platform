import { posix } from 'node:path'
import { type CodePosition, type PdfPosition } from '@kaxolax/contracts'
import { SANDBOX_WORKDIR } from './sandbox.js'

/** Répertoire (relatif au projet) du document principal, où latexmk -cd écrit ses sorties. */
export function rootDirectory(rootResourcePath: string): string {
  const directory = posix.dirname(rootResourcePath)
  return directory === '.' ? '' : directory
}

/** Chemin vu depuis le répertoire du document principal (cwd de TeX, et donc de SyncTeX). */
export function relativeToRoot(file: string, rootDir: string): string {
  return rootDir === '' ? file : posix.relative(rootDir, file)
}

function records(output: string): Record<string, string>[] {
  const start = output.indexOf('SyncTeX result begin')
  const end = output.indexOf('SyncTeX result end')
  if (start === -1 || end === -1) return []
  const result: Record<string, string>[] = []
  let current: Record<string, string> | null = null
  for (const line of output.slice(start, end).split('\n')) {
    const match = /^(\w+):(.*)$/.exec(line.trim())
    if (!match) continue
    const [, key = '', value = ''] = match
    // Chaque résultat commence par « Output: » (view) ou « Input: » (edit).
    if (key === 'Output' || (key === 'Input' && current?.Input !== undefined)) {
      if (current && Object.keys(current).length > 1) result.push(current)
      current = {}
    }
    current ??= {}
    current[key] = value
  }
  if (current && Object.keys(current).length > 1) result.push(current)
  return result
}

/** Sortie de `synctex view` : positions dans le PDF (points, origine en haut à gauche). */
export function parseSynctexView(output: string): PdfPosition[] {
  return records(output)
    .filter((record) => record.Page !== undefined)
    .map((record) => ({
      page: Number(record.Page),
      h: Number(record.h),
      v: Number(record.v),
      width: Number(record.W),
      height: Number(record.H),
    }))
    .filter((position) => Number.isInteger(position.page) && position.page > 0)
}

/** Sortie de `synctex edit` : fichier et ligne sources, ramenés à un chemin du projet. */
export function parseSynctexEdit(output: string, rootDir: string): CodePosition[] {
  return records(output)
    .filter((record) => record.Input !== undefined && record.Line !== undefined)
    .map((record) => {
      let input = record.Input ?? ''
      if (input.startsWith(`${SANDBOX_WORKDIR}/`)) {
        input = posix.normalize(input.slice(SANDBOX_WORKDIR.length + 1))
      } else if (!input.startsWith('/')) {
        input = posix.normalize(posix.join(rootDir, input))
      }
      return {
        file: input,
        line: Number(record.Line),
        column: Math.max(0, Number(record.Column ?? 0)),
      }
    })
    .filter((position) => Number.isInteger(position.line) && position.line > 0)
}
