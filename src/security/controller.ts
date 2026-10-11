export class SecurityController {
  private killed = false;
  private reason = "";
  private cancellation = new AbortController();
  get signal(): AbortSignal { return this.cancellation.signal; }
  kill(reason = "Security kill switch activated"): void { this.killed = true; this.reason = reason; this.cancellation.abort(new Error("Sofia security kill switch is active: " + reason)); }
  revive(): void { this.killed = false; this.reason = ""; this.cancellation = new AbortController(); }
  isKilled(): boolean { return this.killed; }
  status(): { killed: boolean; reason?: string } { return this.killed ? { killed: true, reason: this.reason } : { killed: false }; }
  assertRunning(): void { if (this.killed) throw new Error("Sofia security kill switch is active: " + this.reason); }
}
