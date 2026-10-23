import { motion, useReducedMotion } from 'framer-motion';
import { CircleAlert, Copy, RotateCcw, Square } from 'lucide-react';
import type { AiSummaryState } from '../hooks/useAiSummary';
import { describeError } from '../lib/errors';
import { copyText, formatNumber } from '../lib/format';
import { AI_MODELS } from '../lib/types';
import { classNames } from '../lib/utils';
import { Button } from './Button';
import { GoogleSparkle } from './GoogleSparkle';
import { Markdown } from './Markdown';
import { AiStreamingSkeleton } from './Skeletons';
import { useToast } from './Toasts';

interface AiSummaryCardProps {
  state: AiSummaryState;
  aiEnabled: boolean;
  thinking: boolean;
  onGenerate: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
}

/**
 * Google AI Overview 式总结块：结果列表上方的浅灰区块，
 * 彩色 sparkle + 蓝色文字按钮；SSE 状态机与 testid 保持原样。
 */
export function AiSummaryCard({
  state,
  aiEnabled,
  thinking,
  onGenerate,
  onStop,
  onOpenSettings,
}: AiSummaryCardProps) {
  const reduce = useReducedMotion();
  const { pushToast } = useToast();

  const isStreaming = state.status === 'streaming';
  const hasContent = state.content.trim().length > 0;
  const hasReasoning = state.reasoning.trim().length > 0;
  const isFinal = state.status === 'done' || state.status === 'stopped';
  const description = state.error ? describeError(state.error) : null;
  const modelLabel =
    AI_MODELS.find((model) => model.id === state.model)?.name ?? state.model ?? 'DeepSeek';
  const showGenerateButton = aiEnabled && !isStreaming;
  const generateLabel =
    state.status === 'idle' ? '生成' : state.status === 'error' ? '重试' : '重新生成';

  const handleCopy = (): void => {
    if (!hasContent) return;
    void copyText(state.content).then((ok) => {
      pushToast(ok ? '已复制 AI 总结' : '复制失败，请手动选择文本', ok ? 'success' : 'error');
    });
  };

  return (
    <motion.section
      className={classNames('ai-overview', `ai-overview--${state.status}`)}
      data-testid="ai-summary-card"
      aria-label="AI 总结"
      aria-busy={isStreaming}
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.2, ease: 'easeOut' }}
    >
      <header className="ai-overview__head">
        <GoogleSparkle size={24} className="ai-overview__sparkle" />
        <h2 className="ai-overview__title">AI 总结</h2>
        <p className="ai-overview__meta" aria-live="polite">
          {isStreaming
            ? '正在生成…'
            : state.status === 'error'
              ? '生成失败'
              : `由 ${modelLabel} 生成${thinking ? ' · 思考模式' : ''}`}
        </p>
        <div className="ai-overview__actions">
          {isStreaming ? (
            <Button variant="primary" className="ai-overview__action" onClick={onStop}>
              <Square size={12} aria-hidden="true" />
              停止
            </Button>
          ) : null}
          {showGenerateButton ? (
            <Button
              variant="primary"
              className="ai-overview__action"
              data-testid="ai-summary-button"
              onClick={onGenerate}
            >
              {state.status === 'idle' ? null : <RotateCcw size={13} aria-hidden="true" />}
              {generateLabel}
            </Button>
          ) : null}
        </div>
      </header>

      {!aiEnabled ? (
        <p className="ai-overview__note">
          本站服务未启用 AI 总结功能（/api/health：features.ai = false）。
        </p>
      ) : (
        <div className="ai-overview__body">
          {state.status === 'idle' ? (
            <p className="ai-overview__intro">
              让 DeepSeek 阅读这些搜索结果，生成 300–500 字中文总结，并用 [编号] 标注来源。
            </p>
          ) : null}

          {description ? (
            <div className="ai-overview__error" role="alert">
              <CircleAlert size={16} aria-hidden="true" />
              <div className="ai-overview__error-text">
                <p className="ai-overview__error-title">{description.title}</p>
                <p className="ai-overview__error-message">{description.message}</p>
              </div>
              {description.action === 'settings' ? (
                <Button variant="primary" className="ai-overview__action" onClick={onOpenSettings}>
                  去设置
                </Button>
              ) : null}
            </div>
          ) : null}

          {hasReasoning ? (
            <details className="ai-overview__reasoning">
              <summary>
                思考过程
                {isStreaming && !hasContent ? '（生成中…）' : ''}
              </summary>
              <p>{state.reasoning}</p>
            </details>
          ) : null}

          {hasContent || isStreaming ? (
            <div className="ai-overview__content">
              {hasContent ? <Markdown content={state.content} /> : <AiStreamingSkeleton />}
              {isStreaming ? <span className="typing-cursor" aria-hidden="true" /> : null}
            </div>
          ) : null}

          {state.status === 'stopped' ? (
            <p className="ai-overview__stopped">已停止生成，可点击「重新生成」继续。</p>
          ) : null}
        </div>
      )}

      {isFinal && hasContent ? (
        <footer className="ai-overview__footer">
          <div className="ai-overview__stats">
            {state.usage ? (
              <span>
                用量 {formatNumber(state.usage.promptTokens)} +{' '}
                {formatNumber(state.usage.completionTokens)} ={' '}
                {formatNumber(state.usage.totalTokens)} tokens
              </span>
            ) : null}
            {state.elapsedMs > 0 ? <span>用时 {(state.elapsedMs / 1000).toFixed(1)} 秒</span> : null}
            {state.finishReason && state.finishReason !== 'stop' ? (
              <span>结束原因：{state.finishReason}</span>
            ) : null}
          </div>
          <Button
            variant="quiet"
            className="ai-overview__copy"
            onClick={handleCopy}
            aria-label="复制 AI 总结"
          >
            <Copy size={13} aria-hidden="true" />
            复制
          </Button>
        </footer>
      ) : null}
    </motion.section>
  );
}
