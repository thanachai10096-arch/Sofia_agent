export class SecurityController {
  private killed = false;
  private reason = "";
  kill(reason = "Security kill switch activated"): void { this.killed = true; this.reason = reason; }
  revive(): void { this.killed = false; this.reason = ""; }
  isKilled(): boolean { return this.killed; }
  status(): { killed: boolean; reason?: string } { return this.killed ? { killed: true, reason: this.reason } : { killed: false }; }
  assertRunning(): void { if (this.killed) throw new Error("Sofia security kill switch is active: " + this.reason); }
}
