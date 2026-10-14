export class KeyConcurrencyLimiter {
  private readonly active = new Map<string, number>();

  activeCount(keyId: string): number {
    return this.active.get(keyId) ?? 0;
  }

  tryAcquire(keyId: string, limit: number): boolean {
    const current = this.activeCount(keyId);
    if (current >= limit) return false;
    this.active.set(keyId, current + 1);
    return true;
  }

  release(keyId: string): void {
    const current = this.activeCount(keyId);
    if (current <= 1) this.active.delete(keyId);
    else this.active.set(keyId, current - 1);
  }
}
