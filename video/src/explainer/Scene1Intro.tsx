import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { SafeZone } from './SafeZone';
import { IconTile } from './IconTile';
import { Particles } from './Particles';
import { ICON_PATHS } from './icons';
import { COLORS, FONT_SIZE, SPRING_CONFIG } from './theme';

export const Scene1Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headlineSpring = spring({ frame, fps, config: SPRING_CONFIG });
  const bodySpring = spring({ frame: frame - 10, fps, config: SPRING_CONFIG });

  const tiles = [
    { pathD: ICON_PATHS.diamond, label: 'Game Projections', color: COLORS.accent },
    { pathD: ICON_PATHS.flame, label: 'HR Threats', color: '#f97316' },
    { glyph: 'K', label: 'K Props', color: '#38bdf8' },
  ] as const;

  return (
    <SafeZone
      style={{
        background: `linear-gradient(160deg, ${COLORS.bgTop} 0%, ${COLORS.bgBottom} 100%)`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Particles count={8} opacity={0.35} seedPrefix="s1-particle" />

      <div
        style={{
          opacity: headlineSpring,
          transform: `translateY(${interpolate(headlineSpring, [0, 1], [-24, 0])}px)`,
        }}
      >
        <div style={{ fontSize: FONT_SIZE.headline, fontWeight: 800, lineHeight: 1.1 }}>
          3 Boards. 1 Daily Edge.
        </div>
      </div>
      <div
        style={{
          marginTop: 22,
          opacity: bodySpring,
          transform: `translateY(${interpolate(bodySpring, [0, 1], [-14, 0])}px)`,
        }}
      >
        <div style={{ fontSize: FONT_SIZE.body, color: COLORS.dim, maxWidth: 880, lineHeight: 1.4 }}>
          Every game day, Diamond Report scores today&apos;s MLB slate across three boards — before first pitch.
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 48,
          flexWrap: 'wrap',
        }}
      >
        {tiles.map((tile, i) => (
          <IconTile key={tile.label} {...tile} delay={44 + i * 10} size={150} bobPhase={i * 2} />
        ))}
      </div>
    </SafeZone>
  );
};
