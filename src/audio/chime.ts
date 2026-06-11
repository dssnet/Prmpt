/**
 * Notification chime, synthesized with the Web Audio API — no bundled
 * asset, no licensing. A short two-note "ding" (A5 then C#6), sine waves
 * with a fast attack and an exponential decay.
 */

let ctx: AudioContext | null = null;

export async function playChime(): Promise<void> {
  try {
    ctx ??= new AudioContext();
    // WKWebView can start contexts suspended until a user gesture; the
    // resume is a no-op when already running.
    if (ctx.state === "suspended") await ctx.resume();
    const t0 = ctx.currentTime;
    const notes: ReadonlyArray<readonly [freq: number, at: number]> = [
      [880, 0], // A5
      [1108.73, 0.09], // C#6
    ];
    for (const [freq, at] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.4);
    }
  } catch (e) {
    console.error("[chime] playback failed:", e);
  }
}
