import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError, toApiError } from '../lib/api';
import { summarizeStream } from '../lib/sse';
import type { AiModel, SearchResult, UsageInfo } from '../lib/types';

export type AiSummaryStatus = 'idle' | 'streaming' | 'done' | 'stopped' | 'error';

export interface AiSummaryState {
  status: AiSummaryStatus;
  content: string;
  reasoning: string;
  usage: UsageInfo | null;
  error: ApiError | null;
  model: string;
  requestId: string;
  finishReason: string | null;
  startedAt: number | null;
  elapsedMs: number;
}

const INITIAL_STATE: AiSummaryState = {
  status: 'idle',
  content: '',
  reasoning: '',
  usage: null,
  error: null,
  model: 'deepseek-flash',
  requestId: '',
  finishReason: null,
  startedAt: null,
  elapsedMs: 0,
};

interface UseAiSummaryOptions {
  apiKey: string;
  accessToken: string;
  model: AiModel;
  thinking: boolean;
}

export interface UseAiSummaryResult {
  state: AiSummaryState;
  start: (query: string, results: SearchResult[]) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

/** 管理 AI 总结的流式状态：开始 / 停止 / 重新生成 / 取消。 */
export function useAiSummary(options: UseAiSummaryOptions): UseAiSummaryResult {
  const [state, setState] = useState<AiSummaryState>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const stopRequestedRef = useRef(false);
  const runIdRef = useRef(0);

  const { apiKey, accessToken, model, thinking } = options;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const reset = useCallback((): void => {
    runIdRef.current += 1;
    stopRequestedRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    setState(INITIAL_STATE);
  }, []);

  const start = useCallback(
    async (query: string, results: SearchResult[]): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      stopRequestedRef.current = false;
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      const startedAt = Date.now();
      setState({ ...INITIAL_STATE, status: 'streaming', model, startedAt });

      const isCurrentRun = (): boolean => mountedRef.current && runIdRef.current === runId;

      try {
        const finishReason = await summarizeStream({
          query,
          results,
          model,
          thinking,
          apiKey,
          accessToken: accessToken || undefined,
          signal: controller.signal,
          handlers: {
            onMeta: (meta) => {
              if (!isCurrentRun()) return;
              setState((prev) => ({
                ...prev,
                model: meta.model || prev.model,
                requestId: meta.requestId || prev.requestId,
              }));
            },
            onReasoning: (text) => {
              if (!isCurrentRun()) return;
              setState((prev) => ({ ...prev, reasoning: prev.reasoning + text }));
            },
            onDelta: (text) => {
              if (!isCurrentRun()) return;
              setState((prev) => ({ ...prev, content: prev.content + text }));
            },
            onUsage: (usage) => {
              if (!isCurrentRun()) return;
              setState((prev) => ({ ...prev, usage }));
            },
            onDone: (reason) => {
              if (!isCurrentRun()) return;
              setState((prev) => ({ ...prev, finishReason: reason }));
            },
          },
        });

        if (!isCurrentRun()) return;
        if (stopRequestedRef.current || finishReason === 'aborted') {
          setState((prev) => ({
            ...prev,
            status: 'stopped',
            elapsedMs: Date.now() - startedAt,
          }));
          return;
        }
        setState((prev) => ({
          ...prev,
          status: 'done',
          finishReason,
          elapsedMs: Date.now() - startedAt,
        }));
      } catch (error) {
        if (!isCurrentRun()) return;
        if (stopRequestedRef.current || isAbortError(error)) {
          setState((prev) => ({
            ...prev,
            status: 'stopped',
            elapsedMs: Date.now() - startedAt,
          }));
          return;
        }
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: toApiError(error),
          elapsedMs: Date.now() - startedAt,
        }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [apiKey, accessToken, model, thinking],
  );

  const stop = useCallback((): void => {
    const controller = abortRef.current;
    if (!controller) return;
    stopRequestedRef.current = true;
    abortRef.current = null;
    controller.abort();
    setState((prev) =>
      prev.status === 'streaming'
        ? {
            ...prev,
            status: 'stopped',
            elapsedMs: prev.startedAt ? Date.now() - prev.startedAt : 0,
          }
        : prev,
    );
  }, []);

  return { state, start, stop, reset };
}
