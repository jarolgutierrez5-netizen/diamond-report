import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { DrawOnPath } from './DrawOnPath';
import { idleBob } from './motion';
import { COLORS, FONT_SIZE, SPRING_CONFIG } from './theme';

type IconTileProps = {
  label: string;
  color: string;
  delay: number;
  size?: number;
  bobPhase?: number;
} & ({ pathD: string; glyph?: undefined } | { glyph: string; pathD?: undefined });

export const IconTile: React.FC<IconTileProps> = ({
  pathD,
  glyph,
  label,
  color,
  delay,
  size = 130,
  bobPhase = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: SPRING_CONFIG });
  const scale = interpolate(s, [0, 1], [0.7, 1]);
  const drawProgress = interpolate(frame - delay - 6, [0, 18], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const bob = s >= 0.98 ? idleBob(frame, 6, 0.1, bobPhase) : 0;

  return (
    <div
      style={{
        opacity: s,
        transform: `scale(${scale}) translateY(${bob}px)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 24,
          background: 'rgba(255,255,255,0.06)',
          border: `2px solid ${COLORS.faint}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {pathD ? (
          <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 100 100">
            <DrawOnPath d={pathD} progress={drawProgress} stroke={color} strokeWidth={6} />
          </svg>
        ) : (
          <div
            style={{
              fontSize: size * 0.45,
              fontWeight: 800,
              color,
              opacity: interpolate(drawProgress, [0, 1], [0, 1]),
            }}
          >
            {glyph}
          </div>
        )}
      </div>
      <div style={{ fontSize: FONT_SIZE.label, fontWeight: 600, color: COLORS.dim, textAlign: 'center' }}>
        {label}
      </div>
    </div>
  );
};
