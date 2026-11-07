'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

type RecognitionEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
};
type RecognitionCtor = new () => Recognition;

function getCtor(): RecognitionCtor | null {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * 浏览器自带的语音识别。不可用时只提示，不阻断文字输入；不接后端 ASR。
 */
export function useVoiceInput(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const handler = useRef(onText);

  useEffect(() => {
    handler.current = onText;
  }, [onText]);

  useEffect(
    () => () => {
      recognition.current?.stop();
      recognition.current = null;
    },
    [],
  );

  const toggle = useCallback(() => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Ctor = getCtor();
    if (!Ctor) {
      toast.info('当前浏览器不支持语音输入', {
        description: '可以继续用键盘输入；Chrome / Edge 支持中文语音识别。',
      });
      return;
    }
    const instance = new Ctor();
    instance.lang = 'zh-CN';
    instance.continuous = false;
    instance.interimResults = false;
    instance.onresult = (event) => {
      const text = Array.from({ length: event.results.length }, (_, index) =>
        Array.from(event.results[index], (item) => item.transcript).join(''),
      )
        .join('')
        .trim();
      if (text) handler.current(text);
    };
    instance.onend = () => setListening(false);
    instance.onerror = (event) => {
      setListening(false);
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      toast.error('语音识别没有成功', { description: '再试一次，或者直接打字。' });
    };
    recognition.current = instance;
    setListening(true);
    try {
      instance.start();
    } catch {
      setListening(false);
      toast.error('无法启动语音输入');
    }
  }, [listening]);

  return { listening, toggle };
}
