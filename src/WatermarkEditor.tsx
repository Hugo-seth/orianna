import { useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { ChevronLeft, ChevronRight, ImagePlus, LoaderCircle, RefreshCw, Sparkles, Upload } from 'lucide-react';
import { applyWatermarks, readWatermarkIcon, renderWatermarkedImage, validateWatermarkSettings, WATERMARK_POSITIONS } from './watermark';
import type { WatermarkSettings } from './watermark';
import './watermark.css';

interface WatermarkEditorProps {
  images: string[];
  onApply: (images: string[], settings: WatermarkSettings) => void | Promise<void>;
  onCancel: () => void;
  disabled?: boolean;
  applyLabel?: string;
  settings: WatermarkSettings;
  onSelectImages?: () => void;
  onSettingsChange: (settings: WatermarkSettings) => void;
  preferencesSaving?: boolean;
  preferencesError?: string;
  onRetryPreferences?: () => void;
}

type WatermarkPreview = {
  source: string;
  index: number;
  settings: WatermarkSettings;
} & (
  | { status: 'pending' }
  | { status: 'ready'; image: string }
  | { status: 'error'; error: string }
);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '水印处理失败，请重试。';
}

export function WatermarkEditor({ images, onApply, onCancel, disabled = false, applyLabel = '应用到全部图片', settings, onSelectImages, onSettingsChange, preferencesSaving = false, preferencesError, onRetryPreferences }: WatermarkEditorProps) {
  const id = useId();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewState, setPreviewState] = useState<WatermarkPreview | null>(null);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [iconPending, setIconPending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const applying = useRef(false);
  const latestSettings = useRef(settings);
  const settingsChangeCallback = useRef(onSettingsChange);
  latestSettings.current = settings;
  settingsChangeCallback.current = onSettingsChange;
  const lastFixedPosition = useRef<WatermarkSettings['position']>(settings.position === 'random' ? 'bottom-right' : settings.position);
  const configuringBeforeUpload = images.length === 0 && !!onSelectImages;
  const imageIndex = Math.min(selectedIndex, Math.max(0, images.length - 1));
  const source = images[imageIndex];
  const controlsDisabled = disabled || busy || iconPending;
  const settingsError = validateWatermarkSettings(settings);
  // Match the render inputs synchronously so switching images or settings never
  // presents the previous result as the current preview before effects run.
  const currentPreview = previewState && previewState.source === source && previewState.index === imageIndex && previewState.settings === settings ? previewState : null;
  const canPreview = !!source && !settingsError && !busy;
  const preview = canPreview && currentPreview?.status === 'ready' ? currentPreview.image : '';
  const previewPending = canPreview && (!currentPreview || currentPreview.status === 'pending');
  const previewError = canPreview && currentPreview?.status === 'error' ? currentPreview.error : '';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (settings.position !== 'random') lastFixedPosition.current = settings.position;
  }, [settings.position]);

  useEffect(() => {
    let active = true;
    if (!source || settingsError || busy) {
      setPreviewState(null);
      return;
    }
    const identity = { source, settings, index: imageIndex };
    setPreviewState({ ...identity, status: 'pending' });
    const timer = window.setTimeout(() => {
      void renderWatermarkedImage(source, settings, imageIndex).then(result => {
        if (active) setPreviewState({ ...identity, status: 'ready', image: result });
      }).catch(error => {
        if (active) setPreviewState({ ...identity, status: 'error', error: errorMessage(error) });
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [source, settings, settingsError, imageIndex, busy]);

  function updateSettings(patch: Partial<WatermarkSettings>) {
    setActionError('');
    const nextSettings = { ...latestSettings.current, ...patch };
    latestSettings.current = nextSettings;
    settingsChangeCallback.current(nextSettings);
  }

  async function uploadIcon(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || controlsDisabled) return;
    setIconPending(true);
    setActionError('');
    try {
      const icon = await readWatermarkIcon(file);
      if (mounted.current) updateSettings({ mode: 'icon', icon });
    } catch (error) {
      if (mounted.current) setActionError(errorMessage(error));
    } finally {
      if (mounted.current) setIconPending(false);
    }
  }

  async function apply() {
    if (controlsDisabled || applying.current) return;
    const validationError = images.length || onSelectImages ? validateWatermarkSettings(settings) : '请先上传需要添加水印的图片。';
    if (validationError) {
      setActionError(validationError);
      return;
    }
    if (!images.length && onSelectImages) {
      setActionError('');
      onSelectImages();
      return;
    }
    applying.current = true;
    setBusy(true);
    setActionError('');
    try {
      const watermarkedImages = await applyWatermarks(images, settings);
      if (mounted.current) await onApply(watermarkedImages, settings);
    } catch (error) {
      if (mounted.current) setActionError(errorMessage(error));
    } finally {
      applying.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const visibleError = actionError || previewError;

  return <section className="wm-editor" aria-labelledby={`${id}-heading`} aria-busy={busy}>
    <header className="wm-heading">
      <span className="wm-heading-icon"><Sparkles size={17} aria-hidden="true" /></span>
      <div><h3 id={`${id}-heading`}>图片水印</h3><p>给图片加上你的专属标记</p></div>
      <span className="wm-image-count">{configuringBeforeUpload ? '上传前设置' : `共 ${images.length} 张`}</span>
    </header>

    <div className="wm-body">
      <fieldset className="wm-controls" disabled={controlsDisabled}>
        <legend className="wm-sr-only">水印设置</legend>
        <fieldset className="wm-field">
          <legend>水印来源</legend>
          <div className="wm-segments">
            <label className={settings.mode === 'auto' ? 'is-selected' : ''}>
              <input type="radio" name={`${id}-source`} value="auto" checked={settings.mode === 'auto'} onChange={() => updateSettings({ mode: 'auto' })} />
              <Sparkles size={13} aria-hidden="true" /><span>自动生成</span>
            </label>
            <label className={settings.mode === 'icon' ? 'is-selected' : ''}>
              <input type="radio" name={`${id}-source`} value="icon" checked={settings.mode === 'icon'} onChange={() => updateSettings({ mode: 'icon' })} />
              <ImagePlus size={13} aria-hidden="true" /><span>上传图标</span>
            </label>
          </div>
        </fieldset>

        {settings.mode === 'auto' ? <div className="wm-field">
          <div className="wm-label-row"><label htmlFor={`${id}-text`}>水印文字</label><span>{Array.from(settings.text).length}/40</span></div>
          <input className="wm-text-input" id={`${id}-text`} value={settings.text} placeholder="输入品牌或账号名称" aria-describedby={`${id}-text-help`} onChange={event => updateSettings({ text: Array.from(event.target.value).slice(0, 40).join('') })} />
          <p className="wm-help" id={`${id}-text-help`}>可改为你的账号或品牌名称，最多 40 个字。</p>
        </div> : <div className="wm-field">
          <input ref={fileInput} className="wm-file-input" type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传水印图标" onChange={event => void uploadIcon(event)} />
          <button className="wm-upload" type="button" onClick={() => fileInput.current?.click()}>
            {settings.icon ? <span className="wm-icon-preview"><img src={settings.icon} alt="当前水印图标" /></span> : <Upload size={19} aria-hidden="true" />}
            <span><strong>{iconPending ? '正在读取图标…' : settings.icon ? '更换水印图标' : '选择水印图标'}</strong><small>推荐透明 PNG，也支持 JPG / WebP</small></span>
          </button>
        </div>}

        <fieldset className="wm-field">
          <legend>水印位置</legend>
          <div className="wm-segments">
            <label className={settings.position === 'random' ? 'is-selected' : ''}>
              <input type="radio" name={`${id}-placement`} value="random" checked={settings.position === 'random'} onChange={() => updateSettings({ position: 'random' })} /><span>随机位置</span>
            </label>
            <label className={settings.position !== 'random' ? 'is-selected' : ''}>
              <input type="radio" name={`${id}-placement`} value="fixed" checked={settings.position !== 'random'} onChange={() => updateSettings({ position: lastFixedPosition.current })} /><span>指定位置</span>
            </label>
          </div>
          {settings.position === 'random' ? <div className="wm-random-row"><span>每张图片独立随机，预览与结果一致</span><button className="wm-reroll" type="button" onClick={() => updateSettings({ seed: settings.seed + 1 })}><RefreshCw size={12} aria-hidden="true" />换一组</button></div> : <div className="wm-position-grid" role="group" aria-label="指定水印位置">
            {WATERMARK_POSITIONS.map(position => <label key={position.value} className={settings.position === position.value ? 'is-selected' : ''}>
              <input type="radio" name={`${id}-position`} value={position.value} checked={settings.position === position.value} onChange={() => { lastFixedPosition.current = position.value; updateSettings({ position: position.value }); }} />
              <span>{position.label}</span>
            </label>)}
          </div>}
        </fieldset>

        <div className="wm-field wm-sliders">
          <div><div className="wm-label-row"><label htmlFor={`${id}-opacity`}>不透明度</label><output htmlFor={`${id}-opacity`}>{Math.round(settings.opacity * 100)}%</output></div><input id={`${id}-opacity`} type="range" min="10" max="100" step="1" value={Math.round(settings.opacity * 100)} onChange={event => updateSettings({ opacity: Number(event.target.value) / 100 })} /></div>
          <div><div className="wm-label-row"><label htmlFor={`${id}-scale`}>水印大小</label><output htmlFor={`${id}-scale`}>{Math.round(settings.scale * 100)}%</output></div><input id={`${id}-scale`} type="range" min="5" max="60" step="1" value={Math.round(settings.scale * 100)} aria-describedby={`${id}-scale-help`} onChange={event => updateSettings({ scale: Number(event.target.value) / 100 })} /><p className="wm-help" id={`${id}-scale-help`}>占图片宽度的比例</p></div>
        </div>
      </fieldset>

      <div className="wm-preview-column">
        <div className="wm-label-row"><strong>效果预览</strong><span>{preview ? '已生成' : previewPending ? '生成中' : source ? '原图' : '待上传'}</span></div>
        <div className="wm-preview-image" aria-busy={previewPending}>
          {source ? <img src={preview || source} alt={`第 ${imageIndex + 1} 张图片${preview ? '的水印效果' : '原图'}`} /> : <div className="wm-preview-empty"><ImagePlus size={25} aria-hidden="true" /><span>{configuringBeforeUpload ? '上传图片后可预览水印效果' : '请先上传图片'}</span></div>}
          {previewPending && <div className="wm-preview-loading"><LoaderCircle className="wm-spin" size={14} aria-hidden="true" />生成预览中…</div>}
        </div>
        {images.length > 0 && <div className="wm-preview-nav">
          <button type="button" aria-label="预览上一张图片" disabled={controlsDisabled || imageIndex === 0 || !images.length} onClick={() => setSelectedIndex(imageIndex - 1)}><ChevronLeft size={16} aria-hidden="true" /></button>
          <span aria-live="polite">{images.length ? imageIndex + 1 : 0} / {images.length}</span>
          <button type="button" aria-label="预览下一张图片" disabled={controlsDisabled || imageIndex >= images.length - 1} onClick={() => setSelectedIndex(imageIndex + 1)}><ChevronRight size={16} aria-hidden="true" /></button>
        </div>}
        <p className="wm-help wm-preview-help">{configuringBeforeUpload ? '先设置水印，再选择图片预览并保存。' : '设置会应用到本次全部图片。'}<br />保留原尺寸，以无损 PNG 输出；仅超过 3 MB 时缩小尺寸，直至不超过 3 MB。</p>
      </div>
    </div>

    {visibleError && <p className="wm-error" role="alert">{visibleError}</p>}
    {!visibleError && settingsError && <p className="wm-validation" role="status">{settingsError}</p>}
    <div className={`wm-preferences-status${preferencesError ? ' is-error' : ''}`} role={preferencesError ? 'alert' : 'status'}>
      <span>{preferencesError || (preferencesSaving ? '正在保存水印设置…' : '水印图标与设置会自动保存在本机')}</span>
      {preferencesError && onRetryPreferences && <button type="button" className="wm-preferences-retry" onClick={onRetryPreferences} disabled={preferencesSaving}>重新保存</button>}
    </div>
    <footer className="wm-footer">
      <p className="wm-save-note" role="status">{busy ? `正在处理 ${images.length} 张图片，请稍候…` : configuringBeforeUpload ? '本次设置会保留，选择图片后可继续调整。' : '应用后保存与发布均使用带水印图片。'}</p>
      <div className="wm-actions"><button className="wm-cancel" type="button" onClick={onCancel} disabled={controlsDisabled}>取消</button><button className="wm-apply" type="button" onClick={() => void apply()} disabled={controlsDisabled || (!images.length && !onSelectImages) || !!settingsError}>{busy ? <><LoaderCircle className="wm-spin" size={14} aria-hidden="true" />处理中…</> : <><Sparkles size={13} aria-hidden="true" />{configuringBeforeUpload ? '选择图片并预览' : applyLabel}</>}</button></div>
    </footer>
  </section>;
}

export default WatermarkEditor;
