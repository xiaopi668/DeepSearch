import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Check,
  CircleCheck,
  CircleX,
  Eye,
  EyeOff,
  ImagePlus,
  LoaderCircle,
  Lock,
  Trash,
  X,
} from 'lucide-react';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { validateApiKey } from '../lib/api';
import { describeError } from '../lib/errors';
import { formatNumber } from '../lib/format';
import { isValidApiKeyFormat } from '../lib/storage';
import { extractThemeSeedFromImage, MATERIAL_SEEDS } from '../lib/theme';
import { AI_MODELS, ALLOWED_COUNTS } from '../lib/types';
import type { AiSettings, BackendStatus, ModelInfo } from '../lib/types';
import { classNames } from '../lib/utils';
import { Button } from './Button';
import { useToast } from './Toasts';

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; models: ModelInfo[] }
  | { status: 'error'; message: string };

const KEY_FORMAT_HINT = '格式应为 sk- 开头，后接 10–200 位字母、数字、_ 或 -。';

interface SettingsModalProps {
  open: boolean;
  apiKey: string;
  accessToken: string;
  accessTokenRequired: boolean;
  settings: AiSettings;
  themeSeed: string;
  backendStatus: BackendStatus;
  backendVersion: string;
  onClose: () => void;
  onSaveKey: (key: string) => void;
  onSaveAccessToken: (token: string) => void;
  onChangeSettings: (patch: Partial<AiSettings>) => void;
  onChangeThemeSeed: (seed: string) => void;
  onClearData: () => void;
}

/** Material You 设置弹窗：tonal surface、28dp 圆角、动态色强调与 Material 开关。 */
export function SettingsModal({
  open,
  apiKey,
  accessToken,
  accessTokenRequired,
  settings,
  themeSeed,
  backendStatus,
  backendVersion,
  onClose,
  onSaveKey,
  onSaveAccessToken,
  onChangeSettings,
  onChangeThemeSeed,
  onClearData,
}: SettingsModalProps) {
  const reduce = useReducedMotion();
  const { pushToast } = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const testAbortRef = useRef<AbortController | null>(null);
  const seedFileRef = useRef<HTMLInputElement>(null);

  const [draftKey, setDraftKey] = useState(apiKey);
  const [draftToken, setDraftToken] = useState(accessToken);
  const [showKey, setShowKey] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });
  const [confirmClear, setConfirmClear] = useState(false);
  const [seedImageBusy, setSeedImageBusy] = useState(false);

  useDialogA11y({ open, onClose, panelRef, initialFocusRef: keyInputRef });

  useEffect(() => {
    if (!open) return;
    setDraftKey(apiKey);
    setDraftToken(accessToken);
    setShowKey(false);
    setShowToken(false);
    setKeyError(null);
    setTestState({ status: 'idle' });
    setConfirmClear(false);
  }, [open, apiKey, accessToken]);

  useEffect(() => {
    if (!open) testAbortRef.current?.abort();
  }, [open]);

  useEffect(
    () => () => {
      testAbortRef.current?.abort();
    },
    [],
  );

  const handleThemeSeedFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setSeedImageBusy(true);
    try {
      const seed = await extractThemeSeedFromImage(file);
      onChangeThemeSeed(seed);
      pushToast('已从图片提取 Material You 主题色', 'success');
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '图片取色失败', 'error');
    } finally {
      setSeedImageBusy(false);
    }
  };

  const handleKeyChange = (value: string): void => {
    setDraftKey(value);
    if (keyError) setKeyError(null);
    if (testState.status === 'ok' || testState.status === 'error') setTestState({ status: 'idle' });
  };

  const handleTest = async (): Promise<void> => {
    const trimmed = draftKey.trim();
    if (!trimmed) {
      setKeyError('请先填写 API Key。');
      keyInputRef.current?.focus();
      return;
    }
    if (!isValidApiKeyFormat(trimmed)) {
      setKeyError(`Key ${KEY_FORMAT_HINT}`);
      keyInputRef.current?.focus();
      return;
    }

    setKeyError(null);
    testAbortRef.current?.abort();
    const controller = new AbortController();
    testAbortRef.current = controller;
    setTestState({ status: 'testing' });

    try {
      const result = await validateApiKey({
        apiKey: trimmed,
        accessToken: draftToken.trim() || undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setTestState({ status: 'ok', models: result.models });
      pushToast('连接成功，API Key 可用', 'success');
    } catch (error) {
      if (controller.signal.aborted) return;
      setTestState({ status: 'error', message: describeError(error).message });
    } finally {
      if (testAbortRef.current === controller) testAbortRef.current = null;
    }
  };

  const handleSave = (): void => {
    const trimmed = draftKey.trim();
    if (trimmed && !isValidApiKeyFormat(trimmed)) {
      setKeyError(`Key ${KEY_FORMAT_HINT}`);
      keyInputRef.current?.focus();
      return;
    }
    onSaveAccessToken(draftToken.trim());
    onSaveKey(trimmed);
    onClose();
  };

  const handleRemove = (): void => {
    onSaveAccessToken(draftToken.trim());
    onSaveKey('');
    onClose();
  };

  const describedBy = keyError ? 'settings-key-hint settings-key-error' : 'settings-key-hint';

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="m-layer"
          key="settings-modal-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.15, ease: 'easeOut' }}
        >
          <div className="m-scrim" onClick={onClose} aria-hidden="true" />
          <motion.div
            ref={panelRef}
            className="m-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            aria-describedby="settings-subtitle"
            data-testid="settings-modal"
            tabIndex={-1}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={{ duration: reduce ? 0 : 0.2, ease: 'easeOut' }}
          >
            <header className="m-dialog__header">
              <div>
                <h2 id="settings-title" className="m-dialog__title">
                  设置
                </h2>
                <p id="settings-subtitle" className="m-dialog__subtitle">
                  配置 DeepSeek API Key 与搜索偏好
                </p>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={onClose}
                aria-label="关闭设置"
                title="关闭"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>

            <div className="m-dialog__body">
              <section className="m-section" aria-labelledby="settings-key-heading">
                <div className="m-section__head">
                  <h3 id="settings-key-heading" className="m-section__title">
                    DeepSeek API Key
                  </h3>
                  <span className={classNames('m-badge', apiKey && 'm-badge--ok')}>
                    {apiKey ? '已保存' : '未配置'}
                  </span>
                </div>

                <div className="m-field">
                  <label className="m-field__label" htmlFor="settings-api-key">
                    API Key
                  </label>
                  <div className="m-field__box">
                    <input
                      ref={keyInputRef}
                      id="settings-api-key"
                      className="m-field__input"
                      data-testid="api-key-input"
                      type={showKey ? 'text' : 'password'}
                      value={draftKey}
                      onChange={(event) => handleKeyChange(event.target.value)}
                      placeholder="sk-…"
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby={describedBy}
                      aria-invalid={keyError ? true : undefined}
                    />
                    <button
                      type="button"
                      className="m-field__icon-button"
                      onClick={() => setShowKey((previous) => !previous)}
                      aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                      aria-pressed={showKey}
                    >
                      {showKey ? (
                        <EyeOff size={18} aria-hidden="true" />
                      ) : (
                        <Eye size={18} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
                <p className="m-hint" id="settings-key-hint">
                  仅保存在本浏览器的 localStorage，不会写入服务器，也不会出现在日志里。
                </p>
                {keyError ? (
                  <p className="m-error" id="settings-key-error" role="alert">
                    {keyError}
                  </p>
                ) : null}

                <div className="m-actions">
                  <Button
                    variant="primary"
                    className="m-text-button"
                    data-testid="api-key-save"
                    onClick={handleSave}
                  >
                    保存
                  </Button>
                  <Button
                    variant="primary"
                    className="m-text-button"
                    data-testid="api-key-test"
                    onClick={() => {
                      void handleTest();
                    }}
                    loading={testState.status === 'testing'}
                  >
                    测试连接
                  </Button>
                  {apiKey ? (
                    <Button variant="ghost" className="m-text-button" onClick={handleRemove}>
                      移除 Key
                    </Button>
                  ) : null}
                </div>

                <div className="m-test-result" aria-live="polite">
                  {testState.status === 'testing' ? (
                    <p className="m-test-result__loading">
                      <LoaderCircle size={15} className="spin" aria-hidden="true" />
                      正在验证 API Key…
                    </p>
                  ) : null}
                  {testState.status === 'ok' ? (
                    <div className="m-test-result__ok">
                      <p className="m-test-result__ok-title">
                        <CircleCheck size={16} aria-hidden="true" />
                        连接成功
                      </p>
                      {testState.models.length > 0 ? (
                        <ul className="m-model-list">
                          {testState.models.map((model) => (
                            <li key={model.id}>
                              <code>{model.id}</code>
                              {model.name ? <span>{model.name}</span> : null}
                              {model.contextWindow ? (
                                <span>{formatNumber(model.contextWindow)} tokens</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="m-hint">上游未返回可用模型列表，但 Key 验证通过。</p>
                      )}
                    </div>
                  ) : null}
                  {testState.status === 'error' ? (
                    <p className="m-test-result__error" role="alert">
                      <CircleX size={16} aria-hidden="true" />
                      {testState.message}
                    </p>
                  ) : null}
                </div>

                {accessTokenRequired ? (
                  <div className="m-subsection">
                    <div className="m-field">
                      <label className="m-field__label" htmlFor="settings-access-token">
                        站点访问口令
                      </label>
                      <div className="m-field__box">
                        <input
                          id="settings-access-token"
                          className="m-field__input"
                          data-testid="access-token-input"
                          type={showToken ? 'text' : 'password'}
                          value={draftToken}
                          onChange={(event) => setDraftToken(event.target.value)}
                          placeholder="站点访问口令"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="m-field__icon-button"
                          onClick={() => setShowToken((previous) => !previous)}
                          aria-label={showToken ? '隐藏访问口令' : '显示访问口令'}
                          aria-pressed={showToken}
                        >
                          {showToken ? (
                            <EyeOff size={18} aria-hidden="true" />
                          ) : (
                            <Eye size={18} aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    </div>
                    <p className="m-hint">
                      本站启用了访问口令（ACCESS_TOKEN），随请求以 X-Access-Token 头发送。
                    </p>
                  </div>
                ) : null}
              </section>

              <section className="m-section" aria-labelledby="settings-ai-heading">
                <h3 id="settings-ai-heading" className="m-section__title">
                  AI 总结设置
                </h3>

                <fieldset className="m-fieldset">
                  <legend className="m-legend">触发方式</legend>
                  <label className="m-radio-row">
                    <input
                      type="radio"
                      className="m-radio-input"
                      name="ai-mode"
                      value="manual"
                      checked={settings.aiMode === 'manual'}
                      onChange={() => onChangeSettings({ aiMode: 'manual' })}
                    />
                    <span className="m-radio" aria-hidden="true" />
                    <span className="m-radio-row__text">
                      <span className="m-radio-row__label">手动</span>
                      <span className="m-radio-row__desc">
                        搜索后不自动生成，点击「AI 总结」按钮时才请求
                      </span>
                    </span>
                  </label>
                  <label className="m-radio-row">
                    <input
                      type="radio"
                      className="m-radio-input"
                      name="ai-mode"
                      value="auto"
                      checked={settings.aiMode === 'auto'}
                      onChange={() => onChangeSettings({ aiMode: 'auto' })}
                    />
                    <span className="m-radio" aria-hidden="true" />
                    <span className="m-radio-row__text">
                      <span className="m-radio-row__label">自动</span>
                      <span className="m-radio-row__desc">每次搜索成功后自动生成 AI 总结</span>
                    </span>
                  </label>
                </fieldset>

                <fieldset className="m-fieldset">
                  <legend className="m-legend">模型</legend>
                  {AI_MODELS.map((model) => (
                    <label key={model.id} className="m-radio-row">
                      <input
                        type="radio"
                        className="m-radio-input"
                        name="ai-model"
                        value={model.id}
                        checked={settings.model === model.id}
                        onChange={() => onChangeSettings({ model: model.id })}
                      />
                      <span className="m-radio" aria-hidden="true" />
                      <span className="m-radio-row__text">
                        <span className="m-radio-row__label">{model.name}</span>
                        <span className="m-radio-row__desc">{model.description}</span>
                        <code className="m-radio-row__code">{model.id}</code>
                      </span>
                    </label>
                  ))}
                </fieldset>

                <div className="m-switch-row">
                  <div className="m-switch-row__text">
                    <span className="m-switch-row__label">思考模式</span>
                    <span className="m-switch-row__desc">
                      开启后首字更慢，但推理更充分（默认关闭）
                    </span>
                  </div>
                  <label className="m-switch">
                    <input
                      type="checkbox"
                      className="m-switch__input"
                      checked={settings.thinking}
                      onChange={(event) => onChangeSettings({ thinking: event.target.checked })}
                      aria-label="思考模式"
                    />
                    <span className="m-switch__track" aria-hidden="true">
                      <span className="m-switch__thumb" />
                    </span>
                  </label>
                </div>

                <div className="m-fieldset">
                  <span className="m-legend" id="settings-count-label">
                    每次条数
                  </span>
                  <div className="m-chips" role="group" aria-labelledby="settings-count-label">
                    {ALLOWED_COUNTS.map((count) => (
                      <button
                        key={count}
                        type="button"
                        className={classNames('m-chip', settings.count === count && 'm-chip--selected')}
                        aria-pressed={settings.count === count}
                        onClick={() => onChangeSettings({ count })}
                      >
                        {count} 条
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="m-section" aria-labelledby="settings-theme-heading">
                <h3 id="settings-theme-heading" className="m-section__title">
                  Material You 主题色
                </h3>
                <p className="m-hint">
                  从一个来源色生成整套动态色板（主色、容器色、表面色与强调色），这是 Material You 的核心。
                </p>

                <div className="m-seed-grid" role="group" aria-label="主题色">
                  {MATERIAL_SEEDS.map((seed) => {
                    const selected = themeSeed.toLowerCase() === seed.color.toLowerCase();
                    return (
                      <button
                        key={seed.id}
                        type="button"
                        className={classNames(
                          'm-seed-swatch',
                          selected && 'm-seed-swatch--selected',
                        )}
                        style={{ '--seed-color': seed.color } as CSSProperties}
                        aria-label={`主题色：${seed.name}`}
                        aria-pressed={selected}
                        title={seed.name}
                        onClick={() => onChangeThemeSeed(seed.color)}
                      >
                        {selected ? <Check size={16} strokeWidth={3} aria-hidden="true" /> : null}
                      </button>
                    );
                  })}
                </div>

                <div className="m-seed-actions">
                  <label className="m-seed-custom" title="自定义主题色">
                    <input
                      type="color"
                      value={themeSeed}
                      onChange={(event) => onChangeThemeSeed(event.target.value)}
                      aria-label="自定义主题色"
                    />
                    <span>自定义颜色</span>
                  </label>
                  <button
                    type="button"
                    className="m-text-button btn btn--ghost"
                    onClick={() => seedFileRef.current?.click()}
                    disabled={seedImageBusy}
                  >
                    {seedImageBusy ? (
                      <LoaderCircle size={15} className="m-seed-spin" aria-hidden="true" />
                    ) : (
                      <ImagePlus size={15} aria-hidden="true" />
                    )}
                    从图片取色
                  </button>
                  <input
                    ref={seedFileRef}
                    type="file"
                    accept="image/*"
                    className="visually-hidden"
                    onChange={handleThemeSeedFile}
                  />
                </div>

                <div className="m-seed-preview">
                  <span
                    className="m-seed-preview__dot"
                    style={{ '--seed-color': themeSeed } as CSSProperties}
                    aria-hidden="true"
                  />
                  <span>当前来源色</span>
                  <code>{themeSeed}</code>
                </div>
              </section>

              <section className="m-section" aria-labelledby="settings-data-heading">
                <h3 id="settings-data-heading" className="m-section__title">
                  本地数据
                </h3>
                <p className="m-hint">
                  清空 API Key、AI 设置、搜索历史与欢迎标记，此操作不可撤销。
                </p>
                {confirmClear ? (
                  <div className="m-confirm" role="alert">
                    <p className="m-confirm__text">确定清空全部本地数据？</p>
                    <div className="m-actions">
                      <Button
                        variant="danger"
                        className="m-text-button"
                        onClick={() => {
                          setConfirmClear(false);
                          onClearData();
                        }}
                      >
                        确认清空
                      </Button>
                      <Button
                        variant="primary"
                        className="m-text-button"
                        onClick={() => setConfirmClear(false)}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="danger"
                    className="m-text-button"
                    onClick={() => setConfirmClear(true)}
                  >
                    <Trash size={15} aria-hidden="true" />
                    清空本地数据
                  </Button>
                )}
              </section>

              <p className="m-privacy">
                <Lock size={14} aria-hidden="true" />
                <span>Key 只保存在本浏览器，经本站服务转发给 DeepSeek，不写入服务器。</span>
              </p>
            </div>

            <footer className="m-dialog__footer">
              <span className="m-status">
                <span
                  className={classNames(
                    'm-status__dot',
                    backendStatus === 'online' && 'm-status__dot--online',
                    backendStatus === 'offline' && 'm-status__dot--offline',
                  )}
                  aria-hidden="true"
                />
                {backendStatus === 'online'
                  ? `本站服务已连接${backendVersion ? ` · v${backendVersion}` : ''}`
                  : backendStatus === 'offline'
                    ? '本站服务未连接（后端未启动）'
                    : '正在检测本站服务…'}
              </span>
              <span>DeepSearch</span>
            </footer>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
