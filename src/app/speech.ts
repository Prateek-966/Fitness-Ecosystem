/**
 * Web Speech API wrapper.
 *
 * The only contract that matters: onResult fires with a transcript and the
 * caller persists it immediately. Everything else here — interim results,
 * the visual state, error recovery — is decoration around that one moment.
 *
 * If this proves too slow on Android in real use, the fallback named in
 * the brief is React Native + Expo with on-device recognition. Nothing
 * outside this file would have to change: the core takes a string.
 */

export interface SpeechResult {
  transcript: string;
  confidence: number | null;
  /** performance.now() at the moment the transcript arrived. */
  at: number;
}

interface Listener {
  onStart?: () => void;
  onInterim?: (text: string) => void;
  onResult: (r: SpeechResult) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
}

const Recognition: any =
  (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;

export const speechSupported = (): boolean => Boolean(Recognition);

export class Mic {
  private rec: any = null;
  private active = false;

  constructor(private lang = 'en-IN') {}

  get listening(): boolean { return this.active; }

  start(listener: Listener): boolean {
    if (!Recognition || this.active) return false;

    const rec = new Recognition();
    rec.lang = this.lang;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => { this.active = true; listener.onStart?.(); };

    rec.onresult = (ev: any) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const alt = res[0];
        if (res.isFinal) {
          listener.onResult({
            transcript: String(alt.transcript).trim(),
            confidence:
              typeof alt.confidence === 'number' && alt.confidence > 0 ? alt.confidence : null,
            at: performance.now(),
          });
        } else {
          listener.onInterim?.(String(alt.transcript));
        }
      }
    };

    rec.onerror = (ev: any) => {
      const map: Record<string, string> = {
        'no-speech': 'Heard nothing.',
        'audio-capture': 'No microphone.',
        'not-allowed': 'Microphone permission denied.',
        network: 'Speech recognition needs a network connection.',
      };
      listener.onError?.(map[ev.error] ?? `Speech error: ${ev.error}`);
    };

    rec.onend = () => {
      this.active = false;
      this.rec = null;
      listener.onEnd?.();
    };

    this.rec = rec;
    try { rec.start(); } catch { this.active = false; return false; }
    return true;
  }

  stop(): void {
    try { this.rec?.stop(); } catch { /* already stopped */ }
  }

  abort(): void {
    try { this.rec?.abort(); } catch { /* already stopped */ }
    this.active = false;
  }
}
