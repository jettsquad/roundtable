/**
 * dictate.tsx — the microphone next to the send button.
 *
 * The browser's own recogniser, not the host's: it is free, it needs no key,
 * and the audio never passes through this program. Chrome only — Firefox has
 * no implementation — so the button is simply absent where it would not work
 * rather than present and dead.
 *
 * It fills the box; it never sends. Recognition mishears exactly the words
 * this product is full of — seat names, 「MiniMax」, 「seatKey」 — and a round
 * costs real money, so 「说完自动发」 would spend it on an instruction nobody
 * checked. What you dictate lands as text you can fix first.
 */
import { useEffect, useRef, useState } from "react";
import styles from "./panel.module.css";

interface Recogniser {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

/** Chrome exposes it prefixed; the standard name is there in newer builds. */
function recogniserClass(): (new () => Recogniser) | undefined {
  const scope = globalThis as unknown as {
    SpeechRecognition?: new () => Recogniser;
    webkitSpeechRecognition?: new () => Recogniser;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export function Dictate({ onText }: { readonly onText: (text: string) => void }): JSX.Element | null {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const held = useRef<Recogniser | undefined>(undefined);
  const supported = recogniserClass() !== undefined;

  // Stopped when this composer goes away — a recogniser left running holds
  // the microphone open, and the browser keeps showing the recording dot for
  // a page that is no longer listening to anything.
  useEffect(() => {
    return () => {
      held.current?.stop();
      held.current = undefined;
    };
  }, []);

  if (!supported) return null;

  const start = (): void => {
    const Recognition = recogniserClass();
    if (Recognition === undefined) return;
    setError(undefined);
    const recogniser = new Recognition();
    recogniser.lang = "zh-CN";
    recogniser.continuous = true;
    // Final results only. Interim text arrives and is then revised, and
    // watching it rewrite itself inside the box you are about to send from is
    // worse than waiting the extra second.
    recogniser.interimResults = false;
    recogniser.onresult = (event) => {
      const results = Array.from({ length: event.results.length }, (_, index) => event.results[index]);
      const text = results
        .map((result) => (result === undefined ? "" : (result[0]?.transcript ?? "")))
        .join("")
        .trim();
      if (text !== "") onText(text);
    };
    recogniser.onerror = (event) => {
      setError(
        event.error === "not-allowed"
          ? "浏览器没给麦克风权限——地址栏左边那个图标可以改。"
          : `识别出错：${event.error ?? "未知"}`,
      );
    };
    recogniser.onend = () => {
      setListening(false);
      held.current = undefined;
    };
    held.current = recogniser;
    recogniser.start();
    setListening(true);
  };

  return (
    <>
      <button
        type="button"
        className={styles.button}
        title={listening ? "停止听写" : "说话，转成文字填进输入框（不会自动发送）"}
        onClick={() => {
          if (listening) held.current?.stop();
          else start();
        }}
      >
        {listening ? "● 听写中" : "🎤 说"}
      </button>
      {error === undefined ? null : <span className={styles.error}>{error}</span>}
    </>
  );
}
