import { request } from 'node:http'

/**
 * Client minimal de l'API Docker Engine, par le socket Unix de l'hôte (aucune dépendance). Seul
 * l'agent parle au socket : il n'est jamais monté dans un conteneur de compilation.
 */
const API_VERSION = 'v1.44'

export class DockerError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

export interface ContainerSpec {
  Image: string
  Cmd: string[]
  User: string
  WorkingDir: string
  Env: string[]
  Labels: Record<string, string>
  NetworkDisabled: boolean
  HostConfig: Record<string, unknown>
}

export class DockerClient {
  constructor(private readonly socketPath: string) {}

  private call<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolvePromise, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: `/${API_VERSION}${path}`,
          method,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {},
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            const status = res.statusCode ?? 0
            if (status >= 400) {
              let message = text
              try {
                message = (JSON.parse(text) as { message?: string }).message ?? text
              } catch {
                // Réponse non JSON : on garde le texte brut.
              }
              reject(new DockerError(status, `${method} ${path}: ${message}`))
              return
            }
            resolvePromise((text === '' ? undefined : JSON.parse(text)) as T)
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error(`${method} ${path}: timeout`)))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  async ping(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const req = request(
        { socketPath: this.socketPath, path: '/_ping', timeout: 5_000 },
        (res) => {
          res.resume()
          if (res.statusCode === 200) resolvePromise()
          else reject(new Error(`Docker ping returned ${String(res.statusCode)}`))
        },
      )
      req.on('error', reject)
      req.end()
    })
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.call('GET', `/images/${encodeURIComponent(image)}/json`)
      return true
    } catch (error) {
      if (error instanceof DockerError && error.statusCode === 404) return false
      throw error
    }
  }

  async createContainer(name: string, spec: ContainerSpec): Promise<string> {
    const created = await this.call<{ Id: string }>(
      'POST',
      `/containers/create?name=${encodeURIComponent(name)}`,
      spec,
    )
    return created.Id
  }

  async startContainer(id: string): Promise<void> {
    await this.call('POST', `/containers/${id}/start`)
  }

  /** Attend la fin du conteneur ; renvoie son code de sortie. */
  async waitContainer(id: string, timeoutMs: number): Promise<number> {
    const result = await this.call<{ StatusCode: number }>(
      'POST',
      `/containers/${id}/wait`,
      undefined,
      timeoutMs,
    )
    return result.StatusCode
  }

  async killContainer(id: string): Promise<void> {
    try {
      await this.call('POST', `/containers/${id}/kill`)
    } catch (error) {
      // 404 : déjà supprimé ; 409 : déjà arrêté.
      if (!(
        error instanceof DockerError &&
        (error.statusCode === 404 || error.statusCode === 409)
      )) {
        throw error
      }
    }
  }

  async inspectContainer(id: string): Promise<{ State: { OOMKilled: boolean; ExitCode: number } }> {
    return this.call('GET', `/containers/${id}/json`)
  }

  async removeContainer(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/containers/${id}?force=true&v=true`)
    } catch (error) {
      if (!(error instanceof DockerError && error.statusCode === 404)) throw error
    }
  }

  /** Sortie standard et erreur (format multiplexé de Docker), tronquée à `maxBytes`. */
  async containerLogs(id: string, maxBytes = 256 * 1024): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: `/${API_VERSION}/containers/${id}/logs?stdout=true&stderr=true`,
          method: 'GET',
          timeout: 10_000,
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            if (size < maxBytes) chunks.push(chunk)
            size += chunk.length
          })
          res.on('end', () => {
            resolvePromise(demultiplex(Buffer.concat(chunks)).slice(0, maxBytes))
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
  }
}

/** Retire les en-têtes de 8 octets du flux multiplexé stdout/stderr de Docker. */
export function demultiplex(buffer: Buffer): string {
  const parts: Buffer[] = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4)
    parts.push(buffer.subarray(offset + 8, offset + 8 + size))
    offset += 8 + size
  }
  if (offset === 0) return buffer.toString('utf8')
  return Buffer.concat(parts).toString('utf8')
}
