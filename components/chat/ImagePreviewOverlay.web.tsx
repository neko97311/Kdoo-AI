import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18n } from '@/i18n';

interface ImagePreviewOverlayProps {
  uris: string[];
  initialIndex?: number;
  onClose: () => void;
}

const ZOOM_SCALE = 2.5;
/** "已下载"提示气泡停留时长。 */
const NOTICE_MS = 2000;

/** 从 URL 路径里取图片文件名;非可识别扩展名兜底 image.jpg。 */
function fileNameFromUri(uri: string): string {
  const lastSegment = uri.split(/[?#]/)[0]?.split('/').pop() ?? '';
  return /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(lastSegment) ? lastSegment : 'image.jpg';
}

/** Clamp a page index into [0, length - 1]; 0 when the list is empty. */
function clampIndex(raw: number, length: number): number {
  return Math.max(0, Math.min(raw, Math.max(0, length - 1)));
}

/**
 * Web variant of the fullscreen image viewer.
 *
 * Simplified vs. the native viewer: double-click toggles zoom (1x <-> 2.5x,
 * panning while zoomed comes for free from the scroll container) and the
 * circular bottom button downloads via fetch → blob → <a download> (with a
 * window.open fallback when the fetch fails, e.g. CORS). Backdrop click or
 * the close button dismisses the overlay.
 *
 * Gallery mode (uris.length > 1): prev/next arrows — plus ←/→ and Escape
 * keys — page through the list, a top-center "n / N" counter tracks the
 * position, and download always targets the current page.
 */
export function ImagePreviewOverlay({ uris, initialIndex = 0, onClose }: ImagePreviewOverlayProps) {
  const [currentIndex, setCurrentIndex] = useState(() => clampIndex(initialIndex, uris.length));
  const [zoomed, setZoomed] = useState(false);
  /** Last image list handed in — spots a newly-opened set (overlay stays
   *  mounted between previews; uris = [] while closed). */
  const [prevUris, setPrevUris] = useState(uris);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentUri = uris[currentIndex];
  const hasMany = uris.length > 1;
  const atStart = currentIndex === 0;
  const atEnd = currentIndex >= uris.length - 1;

  const goPrev = useCallback(() => setCurrentIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(
    () => setCurrentIndex((i) => Math.min(i + 1, Math.max(0, uris.length - 1))),
    [uris.length],
  );

  // Every newly previewed image starts un-zoomed, not-saving, and notice-free.
  useEffect(() => {
    setZoomed(false);
    setSaving(false);
    setNotice(null);
    return () => {
      if (noticeTimer.current) {
        clearTimeout(noticeTimer.current);
        noticeTimer.current = null;
      }
    };
  }, [currentUri]);

  // Keyboard navigation: ←/→ page through the gallery, Escape closes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        setCurrentIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'ArrowRight') {
        setCurrentIndex((i) => Math.min(i + 1, Math.max(0, uris.length - 1)));
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [uris.length, onClose]);

  // When the parent swaps in a new non-empty set, reset the page to the
  // requested initialIndex — synchronously during render (same rationale as
  // the native impl: the reset must land before this set's UI commits).
  if (uris !== prevUris && uris.length > 0) {
    setPrevUris(uris);
    setCurrentIndex(clampIndex(initialIndex, uris.length));
  }

  if (uris.length === 0 || !currentUri) return null;

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  /** 下载成功后短暂显示的"已下载"气泡,到时自动消失。 */
  const flashNotice = (message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  const handleSave = async () => {
    if (!currentUri || saving) return;
    setSaving(true);
    try {
      // 走 fetch + blob 转 object URL,跨域资源也能触发浏览器下载对话框。
      const response = await fetch(currentUri);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = fileNameFromUri(currentUri);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      flashNotice(i18n.t('imagePreview.saved'));
    } catch {
      // fetch 失败(如 CORS 限制)时回退为直接打开原图,由用户自行保存。
      window.open(currentUri, '_blank');
    } finally {
      setSaving(false);
    }
  };

  // Shared circular-button chrome (close / prev / next share the same look).
  const circle: React.CSSProperties = {
    position: 'absolute',
    zIndex: 3,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.15)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    color: '#fff',
    lineHeight: 1,
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        backgroundColor: 'rgba(0,0,0,0.9)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onClose();
        }}
        title={i18n.t('imagePreview.close')}
        aria-label={i18n.t('imagePreview.close')}
        role="button"
        style={{ ...circle, top: 48, right: 16, cursor: 'pointer', fontSize: 20 }}
      >
        ✕
      </div>

      {hasMany && (
        <>
          {/* Prev — kept rendered at the ends (dimmed) so the layout is stable. */}
          <div
            onClick={atStart ? stop : (e) => { e.stopPropagation(); goPrev(); }}
            title={i18n.t('imagePreview.previous')}
            aria-label={i18n.t('imagePreview.previous')}
            aria-disabled={atStart}
            role="button"
            style={{
              ...circle,
              top: '50%',
              left: 12,
              transform: 'translateY(-50%)',
              fontSize: 28,
              cursor: atStart ? 'default' : 'pointer',
              opacity: atStart ? 0.3 : 1,
            }}
          >
            ‹
          </div>
          {/* Next */}
          <div
            onClick={atEnd ? stop : (e) => { e.stopPropagation(); goNext(); }}
            title={i18n.t('imagePreview.next')}
            aria-label={i18n.t('imagePreview.next')}
            aria-disabled={atEnd}
            role="button"
            style={{
              ...circle,
              top: '50%',
              right: 12,
              transform: 'translateY(-50%)',
              fontSize: 28,
              cursor: atEnd ? 'default' : 'pointer',
              opacity: atEnd ? 0.3 : 1,
            }}
          >
            ›
          </div>
          {/* Page counter — top center. */}
          <div
            style={{
              position: 'absolute',
              top: 58,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 3,
              color: 'rgba(255,255,255,0.85)',
              fontSize: 13,
              pointerEvents: 'none',
            }}
          >
            {currentIndex + 1} / {uris.length}
          </div>
        </>
      )}

      {/*
        Scroll container: `margin: auto` on the img (instead of flexbox
        centering) keeps the top-left overflow reachable when zoomed, so
        panning is just scrolling.
      */}
      <div
        onClick={stop}
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          cursor: zoomed ? 'zoom-out' : 'zoom-in',
        }}
      >
        <img
          src={currentUri}
          alt="Preview"
          onClick={stop}
          onDoubleClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            setZoomed((prev) => !prev);
          }}
          draggable={false}
          style={{
            margin: 'auto',
            maxWidth: '90vw',
            maxHeight: '90vh',
            objectFit: 'contain',
            userSelect: 'none',
            transformOrigin: 'center center',
            transform: zoomed ? `scale(${ZOOM_SCALE})` : 'scale(1)',
            transition: 'transform 0.25s ease',
          }}
        />
      </div>

      {notice !== null && (
        <div
          style={{
            position: 'absolute',
            bottom: 92,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 3,
            padding: '6px 14px',
            borderRadius: 16,
            backgroundColor: 'rgba(255,255,255,0.16)',
            color: '#fff',
            fontSize: 13,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {notice}
        </div>
      )}

      <div
        onClick={(e) => {
          e.stopPropagation();
          void handleSave();
        }}
        title={i18n.t('imagePreview.download')}
        aria-label={i18n.t('imagePreview.download')}
        role="button"
        style={{
          position: 'absolute',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 3,
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: 'rgba(255,255,255,0.15)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          cursor: saving ? 'default' : 'pointer',
          opacity: saving ? 0.6 : 1,
          color: '#fff',
          fontSize: 22,
          lineHeight: 1,
        }}
      >
        {saving ? '…' : '↓'}
      </div>
    </div>
  );
}
