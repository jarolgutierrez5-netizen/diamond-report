import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { DrawOnPath } from './DrawOnPath';
import { COLORS, LOGO_FONT_FAMILY, SPRING_CONFIG } from './theme';

// Reproduces the real site header mark (index.html #dr-header-logo SVG) at
// a larger scale for a hero outro moment, animated in instead of static.
export const Logo: React.FC<{ scale?: number; delay?: number }> = ({ scale = 1.6, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const local = frame - delay;

  const markDraw = interpolate(local, [0, 22], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const bar1 = spring({ frame: local - 14, fps, config: SPRING_CONFIG });
  const bar2 = spring({ frame: local - 20, fps, config: SPRING_CONFIG });
  const bar3 = spring({ frame: local - 26, fps, config: SPRING_CONFIG });
  const wordmark = spring({ frame: local - 30, fps, config: SPRING_CONFIG });

  return (
    <svg
      aria-label="Diamond Report"
      width={460 * scale}
      height={100 * scale}
      viewBox="0 0 460 100"
      style={{ overflow: 'visible' }}
    >
      <g transform="translate(48,50)">
        <DrawOnPath
          d="M0,-38 L38,0 L0,38 L-38,0 Z"
          progress={markDraw}
          stroke={COLORS.brand}
          strokeWidth={4.5}
        />
        <rect
          fill={COLORS.brand}
          height={16}
          rx={1.5}
          width={7}
          x={-16}
          y={2 + 16 * (1 - bar1)}
          opacity={bar1}
        />
        <rect
          fill={COLORS.brand}
          height={26}
          rx={1.5}
          width={7}
          x={-4.5}
          y={-8 + 26 * (1 - bar2)}
          opacity={bar2}
        />
        <rect
          fill="#ffffff"
          opacity={0.9 * bar3}
          height={36}
          rx={1.5}
          width={7}
          x={7}
          y={-18 + 36 * (1 - bar3)}
        />
      </g>
      <g
        style={{
          opacity: wordmark,
          transform: `translateX(${interpolate(wordmark, [0, 1], [-16, 0])}px)`,
          transformOrigin: '106px 62px',
        }}
      >
        <text
          fill="#ffffff"
          fontFamily={LOGO_FONT_FAMILY}
          fontSize={34}
          fontWeight={800}
          letterSpacing={-0.3}
          x={106}
          y={62}
        >
          DIAMOND <tspan fill={COLORS.brand}>REPORT</tspan>
        </text>
      </g>
    </svg>
  );
};
