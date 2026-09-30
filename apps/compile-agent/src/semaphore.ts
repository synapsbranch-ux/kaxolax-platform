/** Limite le nombre de compilations simultanées ; les demandes suivantes attendent leur tour. */
export class Semaphore {
  private current = 0
  private readonly queue: (() => void)[] = []

  constructor(private readonly capacity: number) {}

  get active(): number {
    return this.current
  }

  get waiting(): number {
    return this.queue.length
  }

  async acquire(): Promise<() => void> {
    if (this.current < this.capacity) {
      this.current++
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next) next()
      else this.current--
    }
  }
}
