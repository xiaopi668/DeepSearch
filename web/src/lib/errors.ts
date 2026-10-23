import { ApiError } from './api';

export type ErrorAction = 'settings' | 'retry' | null;

export interface ErrorDescription {
  title: string;
  message: string;
  action: ErrorAction;
  actionLabel: string | null;
  requestId: string | null;
}

/**
 * 按契约里的 error.code 给出中文提示与动作（不依赖服务端 message 做逻辑判断）。
 * 说明：search/fetch/validate-key 的重试由服务端负责，前端只提供用户手动重试。
 */
export function describeError(error: unknown): ErrorDescription {
  const apiError = error instanceof ApiError ? error : null;
  const code = apiError?.code ?? 'unknown_error';
  const requestId = apiError?.requestId ?? null;

  const withRetry = (title: string, message: string): ErrorDescription => ({
    title,
    message,
    action: 'retry',
    actionLabel: '重试',
    requestId,
  });

  switch (code) {
    case 'missing_api_key':
    case 'invalid_api_key':
      return {
        title: 'API Key 无效或未设置',
        message: '请打开设置，检查并保存你的 DeepSeek API Key，然后重试。',
        action: 'settings',
        actionLabel: '去设置',
        requestId,
      };
    case 'access_denied':
      return {
        title: '需要站点访问口令',
        message: '本站启用了访问口令，请在设置中填写站点访问口令（X-Access-Token）。',
        action: 'settings',
        actionLabel: '去设置',
        requestId,
      };
    case 'insufficient_balance':
      return withRetry('DeepSeek 账户余额不足', '你的 DeepSeek 账户余额不足，请充值后再试。');
    case 'rate_limited':
      return withRetry(
        '请求过于频繁',
        apiError?.retryAfter
          ? `请等待约 ${apiError.retryAfter} 秒后再试。`
          : '请稍后再试，或降低搜索频率。',
      );
    case 'upstream_error':
      return withRetry('DeepSeek 暂时不可用', 'DeepSeek 上游服务暂时异常，请稍后重试。');
    case 'upstream_timeout':
      return withRetry('请求超时', '调用 DeepSeek 超时了，请稍后重试。');
    case 'upstream_unreachable':
      return withRetry('无法连接 DeepSeek', '本站服务无法连接 DeepSeek 上游，请稍后重试。');
    case 'fetch_forbidden':
      return withRetry('该网页拒绝抓取', '该网页被目标站点或安全策略拒绝，无法获取正文。');
    case 'fetch_unavailable':
      return withRetry('正文抓取失败', '无法抓取该网页正文，请打开原页查看。');
    case 'invalid_request':
      return {
        title: '请求参数不合法',
        message: apiError?.message || '请调整搜索内容后重试。',
        action: 'retry',
        actionLabel: '重试',
        requestId,
      };
    case 'network_error':
      return withRetry(
        '无法连接本站服务',
        '后端服务似乎未启动或网络已断开，请确认 DeepSearch 服务运行后重试。',
      );
    case 'stream_interrupted':
      return withRetry('AI 总结中断', '与本站的流式连接中断了，请点击重试。');
    case 'invalid_response':
      return withRetry('服务返回异常', '本站服务返回了无法识别的数据，请稍后重试。');
    case 'aborted':
      return { title: '已取消', message: '请求已取消。', action: null, actionLabel: null, requestId };
    default: {
      if (/^http_\d+$/.test(code)) {
        const isAuth = apiError?.status === 401 || apiError?.status === 403;
        return {
          title: '请求失败',
          message: apiError?.message || '本站服务返回错误，请稍后重试。',
          action: isAuth ? 'settings' : 'retry',
          actionLabel: isAuth ? '去设置' : '重试',
          requestId,
        };
      }
      return withRetry('出现错误', apiError?.message || '发生未知错误，请稍后重试。');
    }
  }
}

/** 用于 toast 的短提示。 */
export function describeErrorShort(error: unknown): string {
  return describeError(error).title;
}
