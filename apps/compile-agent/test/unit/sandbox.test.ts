import { describe, expect, it } from 'vitest'
import { DRAFT_PRETEX, latexmkCommand } from '../../src/compiler.js'
import { buildContainerSpec, SANDBOX_LIMITS } from '../../src/sandbox.js'

describe('buildContainerSpec', () => {
  const spec = buildContainerSpec(
    { image: 'kaxolax-texlive:2026-full', runtime: 'runsc' },
    { command: ['latexmk'], hostWorkdir: '/var/lib/kaxolax/compiles/p1/files', timeoutMs: 60_000 },
  )
  const host = spec.HostConfig

  it('applies every non-negotiable sandbox rule', () => {
    expect(spec.User).toBe('1000:1000')
    expect(spec.NetworkDisabled).toBe(true)
    expect(host).toMatchObject({
      Runtime: 'runsc',
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Memory: 2 * 1024 * 1024 * 1024,
      MemorySwap: 2 * 1024 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 256,
    })
    expect(SANDBOX_LIMITS.pids).toBe(256)
    expect(host.Tmpfs).toMatchObject({ '/tmp': expect.stringContaining('noexec') as unknown })
    expect(host.Ulimits).toEqual([
      { Name: 'fsize', Soft: 101 * 1024 * 1024, Hard: 101 * 1024 * 1024 },
    ])
  })

  it('mounts only the project directory, never the Docker socket', () => {
    expect(host.Mounts).toEqual([
      expect.objectContaining({
        Type: 'bind',
        Source: '/var/lib/kaxolax/compiles/p1/files',
        Target: '/compile',
        ReadOnly: false,
      }),
    ])
    expect(JSON.stringify(spec)).not.toContain('docker.sock')
    expect(host.Binds).toBeUndefined()
    expect(host.Privileged).toBeUndefined()
  })

  it('passes no environment from the agent', () => {
    expect(spec.Env).toEqual(['HOME=/tmp'])
  })

  it('mounts the project read-only for SyncTeX', () => {
    const readOnly = buildContainerSpec(
      { image: 'i', runtime: 'runc' },
      { command: ['synctex'], hostWorkdir: '/w', readOnly: true, timeoutMs: 1 },
    )
    expect(readOnly.HostConfig.Mounts).toEqual([expect.objectContaining({ ReadOnly: true })])
  })
})

describe('latexmkCommand', () => {
  it('uses the specified command with -norc and the engine flag', () => {
    expect(latexmkCommand('pdflatex', 'main.tex')).toEqual([
      'latexmk',
      '-norc',
      '-cd',
      '-f',
      '-jobname=output',
      '-synctex=1',
      '-interaction=batchmode',
      '-file-line-error',
      '-pdf',
      'main.tex',
    ])
    expect(latexmkCommand('xelatex', 'a.tex')).toContain('-xelatex')
    expect(latexmkCommand('lualatex', 'a.tex')).toContain('-lualatex')
  })

  it('adds constant arguments for the compile options, never shell escape', () => {
    const command = latexmkCommand('pdflatex', 'main.tex', { draft: true, haltOnFirstError: true })
    expect(command).toContain('-halt-on-error')
    expect(command).toContain(`-usepretex=${DRAFT_PRETEX}`)
    expect(command.slice(0, 2)).toEqual(['latexmk', '-norc'])
    expect(command.at(-1)).toBe('main.tex')
    expect(command.some((arg) => arg.includes('shell-escape'))).toBe(false)
    expect(DRAFT_PRETEX).toBe(
      '\\PassOptionsToPackage{draft}{graphicx}\\PassOptionsToPackage{draft}{hyperref}',
    )
    expect(
      latexmkCommand('pdflatex', 'main.tex', { draft: false, haltOnFirstError: false }),
    ).toEqual(latexmkCommand('pdflatex', 'main.tex'))
  })
})
