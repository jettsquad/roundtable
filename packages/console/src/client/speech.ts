/**
 * speech.ts — playing one reply out loud, on demand.
 *
 * On demand, and one reply at a time. The first version read every arriving
 * turn automatically, which was wrong in two ways: it decides for you which
 * answers are worth hearing, and it spends the host's speech quota on all of
 * them to find out. The control belongs on the message — you have just
 * finished reading the part that made you want to hear the rest.
 *
 * Synthesis runs one chunk ahead of playback. A whole reply sent as one
 * request is tens of seconds of silence before any sound, which looks exactly
 * like a feature that does not work; chunking also makes stopping cheap,
 * because nothing further has been synthesised yet.
 */
import { speakableText, speechChunks } from "@squad/shared";
import { api } from "./api.ts";

/** Where the read-aloud choice is remembered. Shared with `ListenBar`. */
export const CONNECTION_KEY = "squad.listen.connection";
export const SPEED_KEY = "squad.listen.speed";

/**
 * Read a remembered value, tolerating storage being unavailable.
 *
 * Private mode and blocked site data throw on access rather than returning
 * null, and a page that cannot remember a preference should still play.
 */
export const remembered = (key: string, fallback: string): string => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

export interface SpeechState {
  /** The turn being spoken, or nothing. */
  readonly turnId: string | undefined;
  /** 1-based, for a button that has to show progress on a long reply. */
  readonly chunk: number;
  readonly chunks: number;
  /** Held at the current position, not ended. `turnId` stays set. */
  readonly paused: boolean;
  readonly error: string | undefined;
}

type Listener = (state: SpeechState) => void;

/**
 * The part of an audio element this file touches.
 *
 * Declared locally because this module is type-checked twice: once by the
 * browser config, which has the DOM lib, and once by the host's, which does
 * not. Naming the four members used is cheaper than teaching the host config
 * about a DOM it will never run in.
 */
interface Playable {
  pause(): void;
  play(): Promise<void>;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

const createAudio = (url: string): Playable =>
  new (globalThis as unknown as { Audio: new (src: string) => Playable }).Audio(url);

const objectUrl = globalThis.URL as unknown as {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
};

class Speaker {
  private turnId: string | undefined;
  private chunk = 0;
  private chunks = 0;
  private error: string | undefined;
  private audio: Playable | undefined;
  /**
   * Held rather than ended.
   *
   * Stopping used to be the only way out of a reading, and it discards the
   * position: coming back meant hearing the whole reply again from the top
   * — and paying to synthesise it again. This flag is what makes the
   * difference between the two, and the chunk loop needs no knowledge of it:
   * it is parked on the current chunk's `onended`, which a paused element
   * does not fire.
   */
  private paused = false;
  /**
   * The synthesis connection, loaded from storage rather than handed in.
   *
   * It used to arrive only from `ListenBar`'s effect — and that component
   * renders in exactly one place, the session's team tab. Read a reply
   * anywhere else and the player had never been told which connection to
   * use, so every ▶ was disabled with a tooltip telling you to go and choose
   * one you had already chosen. The setting was in `localStorage` the whole
   * time; nothing had read it.
   *
   * The player owns its own configuration now. The bar is a control that
   * CHANGES it, not the only thing that loads it.
   */
  private connectionId = remembered(CONNECTION_KEY, "");
  private speed = Number(remembered(SPEED_KEY, "1")) || 1;
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  state(): SpeechState {
    return { turnId: this.turnId, chunk: this.chunk, chunks: this.chunks, paused: this.paused, error: this.error };
  }

  configure(connectionId: string, speed: number): void {
    const changed = connectionId !== this.connectionId;
    this.connectionId = connectionId;
    this.speed = speed;
    // Announced, because `ready` gates every ▶ on screen and those buttons
    // subscribe to this player. Without it, choosing a connection left every
    // already-rendered button disabled until something unrelated re-rendered
    // it — which reads as "I chose one and it still does not work".
    if (changed) this.announce();
  }

  get ready(): boolean {
    return this.connectionId !== "";
  }

  stop(): void {
    this.turnId = undefined;
    this.chunk = 0;
    this.chunks = 0;
    this.paused = false;
    this.audio?.pause();
    this.audio = undefined;
    this.announce();
  }

  /**
   * Hold at the current position.
   *
   * The element keeps its place and the chunk loop stays parked on an
   * `onended` that will not fire, so nothing further is synthesised while
   * held — pausing a long reply stops spending on it, exactly as stopping
   * did.
   */
  pause(): void {
    if (this.turnId === undefined || this.paused) return;
    this.paused = true;
    this.audio?.pause();
    this.announce();
  }

  /**
   * Carry on from where it was held.
   *
   * `audio` is undefined between chunks — while the next one is still being
   * synthesised — and that is not a failure to resume: `say` checks the flag
   * before starting its element, so the chunk that arrives during a pause
   * waits, and this call is what releases it.
   */
  resume(): void {
    if (this.turnId === undefined || !this.paused) return;
    this.paused = false;
    this.announce();
    void this.audio?.play().catch(() => {
      /* a rejected resume leaves the reply held rather than ending it */
    });
  }

  togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  /**
   * Speak one reply. Starting a second stops the first.
   *
   * One at a time because two voices at once is not a feature anybody meant
   * to ask for, and because the stop button on the message you started is the
   * only thing that can be expected to end it.
   */
  async play(item: {
    readonly turnId: string;
    readonly speaker: string;
    readonly text: string;
    readonly voiceId: string;
  }): Promise<void> {
    // Still a stop, not a pause. `VoicePreview` shares this player and its
    // button says 「停」 for a one-line sample, where holding the position is
    // meaningless. The reply reader wants the other behaviour and asks for it
    // by name — `togglePause` — rather than having it inferred here.
    if (this.turnId === item.turnId) {
      this.stop();
      return;
    }
    this.stop();
    const chunks = speechChunks(speakableText(item.text));
    if (chunks.length === 0) return;
    this.turnId = item.turnId;
    this.chunks = chunks.length;
    this.error = undefined;
    this.announce();

    for (const [index, chunk] of chunks.entries()) {
      // Checked between chunks: a stop, or another message being started,
      // lands here rather than after the whole reply has been paid for.
      if (this.turnId !== item.turnId) return;
      this.chunk = index + 1;
      this.announce();
      const ok = await this.say(chunk, item.voiceId);
      if (!ok) return;
    }
    if (this.turnId === item.turnId) this.stop();
  }

  private announce(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }

  /** @returns false when playback should not continue. */
  private async say(text: string, voiceId: string): Promise<boolean> {
    try {
      const blob = await api.speak({ text, connectionId: this.connectionId, voiceId, speed: this.speed });
      if (this.turnId === undefined) return false;
      const url = objectUrl.createObjectURL(blob);
      const audio = createAudio(url);
      this.audio = audio;
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        // A failed element is not a failed feature: let the next chunk try
        // rather than ending the whole reply.
        audio.onerror = () => resolve();
        // Not while held. A chunk whose synthesis finished DURING a pause
        // would otherwise start talking on its own — the one moment where
        // pausing has no element to pause. `resume` starts this one instead.
        if (!this.paused) void audio.play().catch(() => resolve());
      });
      objectUrl.revokeObjectURL(url);
      // Dropped as soon as it has finished. `resume` plays whatever `audio`
      // holds, and an ended element still held here would replay the chunk
      // just heard instead of continuing.
      if (this.audio === audio) this.audio = undefined;
      return true;
    } catch (problem) {
      // Kept and shown. MiniMax refuses with reasons — an exhausted quota, a
      // model the subscription does not cover — and that sentence is the
      // whole value of the failure.
      this.error = problem instanceof Error ? problem.message : String(problem);
      this.turnId = undefined;
      this.announce();
      return false;
    }
  }
}

export const speech = new Speaker();
