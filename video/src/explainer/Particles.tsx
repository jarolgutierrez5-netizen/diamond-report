import React from 'react';
import { AbsoluteFill, interpolate, random, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from './theme';

export const Particles: React.FC<{ count?: number; opacity?: number; seedPrefix?: string; color?: string }> = ({
  count = 14,
  opacity = 1,
  seedPrefix = 'particle',
  color = COLORS.accent,
}) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();

  const particles = new Array(count).fill(0).map((_, i) => {
    const seed = `${seedPrefix}-${i}`;
    const x = 40 + random(`${seed}-x`) * (width - 80);
    const speed = 0.5 + random(`${seed}-speed`) * 1.1;
    const size = 4 + random(`${seed}-size`) * 9;
    const delay = random(`${seed}-delay`) * durationInFrames * 0.5;
    const startY = height + random(`${seed}-start`) * 200;
    const y = startY - Math.max(0, frame - delay) * speed;
    const particleOpacity = interpolate(
      y,
      [-80, 120, height - 150, height + 80],
      [0, 0.55 * opacity, 0.55 * opacity, 0],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
    );
    return { x, y, size, opacity: particleOpacity, key: seed };
  });

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
        {particles.map((p) => (
          <circle key={p.key} cx={p.x} cy={p.y} r={p.size} fill={color} opacity={p.opacity} />
        ))}
      </svg>
    </AbsoluteFill>
  );
};
