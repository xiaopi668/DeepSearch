import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { classNames } from '../lib/utils';

const markdownComponents: Components = {
  a(props) {
    const { node, ...rest } = props;
    void node;
    return <a {...rest} className="md-link" target="_blank" rel="noopener noreferrer" />;
  },
  img(props) {
    const { node, ...rest } = props;
    void node;
    // 外链图片可能来自搜索结果页面，不携带 Referer 降低隐私泄露面
    return (
      <img
        {...rest}
        className="md-image"
        loading="lazy"
        referrerPolicy="no-referrer"
        alt={rest.alt ?? ''}
      />
    );
  },
  table(props) {
    const { node, ...rest } = props;
    void node;
    return (
      <div className="md-table-wrap">
        <table {...rest} />
      </div>
    );
  },
};

interface MarkdownProps {
  content: string;
  className?: string;
}

/** react-markdown + remark-gfm 渲染（GFM 表格/任务列表/删除线等）。 */
export function Markdown({ content, className }: MarkdownProps) {
  return (
    <div className={classNames('markdown-body', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
