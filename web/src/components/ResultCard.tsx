import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import { ChevronDown, ChevronUp, ExternalLink, FileText } from 'lucide-react';
import { breadcrumbOf, formatDate, formatRerankScore, siteNameOf } from '../lib/format';
import type { SearchResult } from '../lib/types';
import { classNames } from '../lib/utils';
import { Button } from './Button';
import { SiteIcon } from './SiteIcon';

const resultVariants: Variants = {
  hidden: { opacity: 0, y: 4 },
  show: { opacity: 1, y: 0, transition: { duration: 0.18, ease: 'easeOut' } },
};

interface ResultCardProps {
  result: SearchResult;
  index: number;
  onOpenFetch: (result: SearchResult) => void;
}

/** Google SERP 扁平结果条目：无卡片外框/阴影，hover 仅标题下划线。 */
export function ResultCard({ result, index, onOpenFetch }: ResultCardProps) {
  const [expanded, setExpanded] = useState(false);
  const reduce = useReducedMotion();

  const siteName = siteNameOf(result);
  const date = formatDate(result.date);
  const rerankScore = formatRerankScore(result.rerankScore);
  const summaryText = result.summary.trim();
  const snippetText = result.snippet.trim();
  const hasSummary = summaryText.length > 0 && summaryText !== snippetText;
  const hasLongSnippet = snippetText.length > 110;
  const expandable = hasSummary || hasLongSnippet;
  const summaryId = `result-summary-${index}`;
  const snippetId = `result-snippet-${index}`;
  const metaItems: string[] = [];
  if (date) metaItems.push(date);
  if (result.authority >= 3) metaItems.push('高权威');
  if (rerankScore) metaItems.push(`相关度 ${rerankScore}`);

  return (
    <motion.article
      className="serp-result"
      data-testid="result-card"
      variants={resultVariants}
      transition={{ duration: reduce ? 0 : 0.18, ease: 'easeOut' }}
      aria-labelledby={`result-title-${index}`}
    >
      <div className="serp-result__source">
        <SiteIcon src={result.siteIcon} name={siteName} size={16} className="serp-result__icon" />
        <span className="serp-result__site">{siteName}</span>
        <span className="serp-result__breadcrumb" title={result.url}>
          {breadcrumbOf(result.url)}
        </span>
      </div>

      <h2 className="serp-result__title" id={`result-title-${index}`}>
        <a href={result.url} target="_blank" rel="noopener noreferrer">
          {result.title}
        </a>
      </h2>

      {result.snippet ? (
        <p
          id={snippetId}
          className={classNames(
            'serp-result__snippet',
            expanded && 'serp-result__snippet--expanded',
          )}
        >
          {result.snippet}
        </p>
      ) : null}

      {expandable ? (
        <>
          <AnimatePresence initial={false}>
            {expanded && hasSummary ? (
              <motion.div
                key="summary"
                id={summaryId}
                className="serp-result__summary-wrap"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reduce ? 0 : 0.18, ease: 'easeOut' }}
              >
                <p className="serp-result__summary">{result.summary}</p>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <button
            type="button"
            className="serp-result__expand"
            onClick={() => setExpanded((previous) => !previous)}
            aria-expanded={expanded}
            aria-controls={hasSummary ? summaryId : snippetId}
          >
            {expanded ? '收起摘要' : '展开摘要'}
            {expanded ? (
              <ChevronUp size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )}
          </button>
        </>
      ) : null}

      {metaItems.length > 0 ? (
        <p className="serp-result__meta">
          {metaItems.map((item, metaIndex) => (
            <span key={item}>
              {metaIndex > 0 ? <span className="serp-result__meta-sep"> · </span> : null}
              {item}
            </span>
          ))}
        </p>
      ) : null}

      <div className="serp-result__actions">
        <Button
          variant="quiet"
          className="serp-result__action"
          data-testid="fetch-button"
          onClick={() => onOpenFetch(result)}
        >
          <FileText size={14} aria-hidden="true" />
          查看正文
        </Button>
        <a
          className="serp-result__action serp-result__action--link"
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink size={14} aria-hidden="true" />
          打开原页
        </a>
      </div>
    </motion.article>
  );
}
