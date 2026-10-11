export class SecurityController {
  private killed = false;
  private reason = "";
  private readonly active = new Set<AbortController>();

  kill(reason = "Security kill switch activated"): void {
    this.killed = true;
    this.reason = reason;
    for (const controller of this.active) controller.abort(new Error("Sofia security kill switch is active: " + reason));
    this.active.clear();
  }
  revive(): void { this.killed = false; this.reason = ""; }
  isKilled(): boolean { return this.killed; }
  status(): { killed: boolean; reason?: string } { return this.killed ? { killed: true, reason: this.reason } : { killed: false }; }
  assertRunning(): void { if (this.killed) throw new Error("Sofia security kill switch is active: " + this.reason); }

  bindSignal(parent: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    this.assertRunning();
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parent.reason);
    if (parent.aborted) abortFromParent();
    else parent.addEventListener("abort", abortFromParent, { once: true });
    this.active.add(controller);
    if (this.killed) controller.abort(new Error("Sofia security kill switch is active: " + this.reason));
    return {
      signal: controller.signal,
      dispose: () => {
        this.active.delete(controller);
        parent.removeEventListener("abort", abortFromParent);
      },
    };
  }
}
