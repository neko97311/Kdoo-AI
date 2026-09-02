import React, { useState } from 'react';

interface ImageContentProps {
  uri: string;
  alt?: string;
  onPress?: (uri: string) => void;
  maxWidth?: number;
}

export function ImageContent({ uri, alt, onPress, maxWidth }: ImageContentProps) {
  // Default 3:2 to match ComfyUI output (1296x864).
  // Updated to true ratio onLoad once dimensions are known.
  const [aspectRatio, setAspectRatio] = useState(1.5);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  return (
    <div
      onClick={() => onPress?.(uri)}
      style={{
        width: '100%',
        maxWidth: maxWidth ?? 280,
        aspectRatio,
        borderRadius: 8,
        overflow: 'hidden',
        cursor: onPress ? 'pointer' : undefined,
        backgroundColor: '#F3F4F6',
        position: 'relative',
      }}
    >
      {!loaded && !errored && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg
            className="animate-spin"
            width={24}
            height={24}
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle cx="12" cy="12" r="10" stroke="#D1D5DB" strokeWidth="3" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="#9CA3AF" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </div>
      )}
      {errored && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#9CA3AF',
            fontSize: 13,
          }}
        >
          Failed to load image
        </div>
      )}
      <img
        src={uri}
        alt={alt || ''}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: loaded ? 'block' : 'none',
        }}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth && img.naturalHeight) {
            setAspectRatio(img.naturalWidth / img.naturalHeight);
          }
          setLoaded(true);
        }}
        onError={() => setErrored(true)}
      />
    </div>
  );
}
