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

export interface SpeechState {
  /** The turn being spoken, or nothing. */
  readonly turnId: string | undefined;
  /** 1-based, for a button that has to show progress on a long reply. */
  readonly chunk: number;
  readonly chunks: number;
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
  private connectionId = "";
  private speed = 1;
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  state(): SpeechState {
    return { turnId: this.turnId, chunk: this.chunk, chunks: this.chunks, error: this.error };
  }

  configure(connectionId: string, speed: number): void {
    this.connectionId = connectionId;
    this.speed = speed;
  }

  get ready(): boolean {
    return this.connectionId !== "";
  }

  stop(): void {
    this.turnId = undefined;
    this.chunk = 0;
    this.chunks = 0;
    this.audio?.pause();
    this.audio = undefined;
    this.announce();
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
        void audio.play().catch(() => resolve());
      });
      objectUrl.revokeObjectURL(url);
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
