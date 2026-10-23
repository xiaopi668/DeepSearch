import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CircleAlert, Copy, ExternalLink, FileText, X } from 'lucide-react';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { fetchPageContent, toApiError } from '../lib/api';
import type { ApiError } from '../lib/api';
import { describeError } from '../lib/errors';
import { breadcrumbOf, copyText, formatDate, siteNameOf } from '../lib/format';
import type { FetchResponse, SearchResult } from '../lib/types';
import { Button } from './Button';
import { Markdown } from './Markdown';
import { SiteIcon } from './SiteIcon';
import { DrawerSkeleton } from './Skeletons';
import { useToast } from './Toasts';

type DrawerState =
  | { status: 'loading' }
  | { status: 'success'; data: FetchResponse }
  | { status: 'error'; error: ApiError };

/** 同一浏览器会话内缓存抓取结果（SPA 内切换视图也不失效）。 */
const sessionFetchCache = new Map<string, FetchResponse>();

/**
 * DeepSeek Fetch 返回的 Markdown 常以被转义的标题行（`\# 标题`）开头。
 * 抽屉头部已经展示了标题，这里去掉首行，避免正文开头出现重复的 "# 标题"。
 */
function stripLeadingHeading(content: string, title: string): string {
  const lines = content.split('\n');
  let index = 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  const first = lines[index]?.trim() ?? '';
  const match = first.match(/^\\?#\s+(.+)$/);
  if (!match) return content;

  const heading = match[1].replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1').trim();
  const cleanTitle = title.trim();
  const sameHeading =
    heading.length > 0 &&
    (cleanTitle === heading || cleanTitle.startsWith(heading) || heading.startsWith(cleanTitle));
  if (!sameHeading) return content;

  lines.splice(0, index + 1);
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  return lines.join('\n');
}

interface FetchDrawerProps {
  open: boolean;
  result: SearchResult | null;
  apiKey: string;
  accessToken: string;
  onClose: () => void;
  onExited: () => void;
  onOpenSettings: () => void;
}

/** 右侧滑入的正文抓取抽屉（移动端全宽），同 URL 在会话内缓存。 */
export function FetchDrawer({
  open,
  result,
  apiKey,
  accessToken,
  onClose,
  onExited,
  onOpenSettings,
}: FetchDrawerProps) {
  const reduce = useReducedMotion();
  const { pushToast } = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<DrawerState>({ status: 'loading' });
  const [retryToken, setRetryToken] = useState(0);

  useDialogA11y({ open, onClose, panelRef, initialFocusRef: closeButtonRef });

  const targetUrl = result?.url ?? null;

  useEffect(() => {
    if (!open || !targetUrl) return;

    const cached = sessionFetchCache.get(targetUrl);
    if (cached) {
      setState({ status: 'success', data: cached });
      return;
    }

    const controller = new AbortController();
    setState({ status: 'loading' });
    void (async () => {
      try {
        const data = await fetchPageContent({
          url: targetUrl,
          apiKey,
          accessToken: accessToken || undefined,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        sessionFetchCache.set(targetUrl, data);
        setState({ status: 'success', data });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({ status: 'error', error: toApiError(error) });
      }
    })();

    return () => controller.abort();
  }, [open, targetUrl, retryToken, apiKey, accessToken]);

  const handleCopy = useCallback((): void => {
    if (state.status !== 'success' || !state.data.content) return;
    void copyText(state.data.content).then((ok) => {
      pushToast(ok ? '已复制正文' : '复制失败，请手动选择文本', ok ? 'success' : 'error');
    });
  }, [state, pushToast]);

  if (!result) {
    return <AnimatePresence onExitComplete={onExited}>{null}</AnimatePresence>;
  }

  const siteName = siteNameOf(result);
  const date = formatDate(result.date);
  const title = state.status === 'success' && state.data.title ? state.data.title : result.title;
  const bodyContent =
    state.status === 'success' ? stripLeadingHeading(state.data.content, title) : '';
  const description = state.status === 'error' ? describeError(state.error) : null;

  return (
    <AnimatePresence onExitComplete={onExited}>
      {open ? (
        <motion.div
          className="drawer-layer"
          key="fetch-drawer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.2 }}
        >
          <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
          <motion.div
            ref={panelRef}
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fetch-drawer-title"
            data-testid="fetch-drawer"
            tabIndex={-1}
            initial={reduce ? { opacity: 0 } : { x: '100%' }}
            animate={reduce ? { opacity: 1 } : { x: 0 }}
            exit={reduce ? { opacity: 0 } : { x: '100%' }}
            transition={{ type: 'tween', duration: reduce ? 0 : 0.2, ease: 'easeOut' }}
          >
            <header className="drawer__head">
              <div className="drawer__heading">
                <p className="drawer__eyebrow">
                  <FileText size={14} aria-hidden="true" />
                  查看正文
                </p>
                <h2 className="drawer__title" id="fetch-drawer-title">
                  {title}
                </h2>
                <div className="drawer__meta">
                  <SiteIcon src={result.siteIcon} name={siteName} size={18} />
                  <span>{siteName}</span>
                  {date ? (
                    <>
                      <span className="drawer__dot" aria-hidden="true">
                        ·
                      </span>
                      <span>{date}</span>
                    </>
                  ) : null}
                </div>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                className="icon-btn drawer__close"
                onClick={onClose}
                aria-label="关闭正文抽屉"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>

            <div className="drawer__toolbar">
              <a
                className="btn btn--quiet"
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={15} aria-hidden="true" />
                打开原页
              </a>
              {state.status === 'success' && state.data.content ? (
                <Button variant="quiet" onClick={handleCopy}>
                  <Copy size={14} aria-hidden="true" />
                  复制正文
                </Button>
              ) : null}
              <span className="drawer__url" title={result.url}>
                {breadcrumbOf(result.url)}
              </span>
            </div>

            <div className="drawer__body">
              {state.status === 'loading' ? <DrawerSkeleton /> : null}

              {state.status === 'error' && description ? (
                <div className="drawer__error" role="alert">
                  <CircleAlert size={22} aria-hidden="true" />
                  <div className="drawer__error-text">
                    <p className="drawer__error-title">{description.title}</p>
                    <p className="drawer__error-message">{description.message}</p>
                  </div>
                  <div className="drawer__error-actions">
                    <Button
                      variant="secondary"
                      onClick={() => setRetryToken((token) => token + 1)}
                    >
                      重试
                    </Button>
                    {description.action === 'settings' ? (
                      <Button
                        variant="primary"
                        className="m-text-button"
                        onClick={() => {
                          onClose();
                          onOpenSettings();
                        }}
                      >
                        去设置
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {state.status === 'success' ? (
                bodyContent.trim() ? (
                  <Markdown content={bodyContent} className="drawer__markdown" />
                ) : (
                  <p className="drawer__empty">该页面没有可提取的正文，请打开原页查看。</p>
                )
              ) : null}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
