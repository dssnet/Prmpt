/**
 * Notification sounds, synthesized with the Web Audio API — no bundled
 * asset, no licensing. Two distinct cues: `playChime` is the two-note
 * "ding" (A5 then C#6) for real notifications, `playBell` a single
 * quieter blip for the terminal BEL (tab autocomplete etc.).
 */

let ctx: AudioContext | null = null;

async function audioContext(): Promise<AudioContext> {
  ctx ??= new AudioContext();
  // WKWebView can start contexts suspended until a user gesture; the
  // resume is a no-op when already running.
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}

export async function playChime(): Promise<void> {
  try {
    const ctx = await audioContext();
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

export async function playBell(): Promise<void> {
  try {
    const ctx = await audioContext();
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 659.26; // E5
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.2);
  } catch (e) {
    console.error("[bell] playback failed:", e);
  }
}
