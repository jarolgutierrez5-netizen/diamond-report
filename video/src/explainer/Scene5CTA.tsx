import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { SafeZone } from './SafeZone';
import { Particles } from './Particles';
import { IconTile } from './IconTile';
import { ICON_PATHS } from './icons';
import { COLORS, FONT_SIZE, SPRING_CONFIG } from './theme';

export const Scene5CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headlineSpring = spring({ frame, fps, config: SPRING_CONFIG });
  const bodySpring = spring({ frame: frame - 12, fps, config: SPRING_CONFIG });
  const footerSpring = spring({ frame: frame - 110, fps, config: SPRING_CONFIG });

  const tiles = [
    { pathD: ICON_PATHS.diamond, label: 'Game Projections', color: COLORS.accent },
    { pathD: ICON_PATHS.flame, label: 'HR Threats', color: '#f97316' },
    { glyph: 'K', label: 'K Props', color: '#38bdf8' },
    { pathD: ICON_PATHS.star, label: 'Elite Picks', color: '#facc15' },
  ] as const;

  return (
    <SafeZone
      style={{
        background: `linear-gradient(160deg, ${COLORS.bgTop} 0%, ${COLORS.bgBottom} 100%)`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Particles count={14} />

      <div
        style={{
          opacity: headlineSpring,
          transform: `translateY(${interpolate(headlineSpring, [0, 1], [-24, 0])}px)`,
        }}
      >
        <div style={{ fontSize: FONT_SIZE.headline, fontWeight: 800, lineHeight: 1.1 }}>
          Read It. Don&apos;t Just Bet It.
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
          Every board is a data tool, not a guarantee — check it daily, compare it to your own read, and make the
          call. New slate every morning.
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr 1fr',
          alignItems: 'center',
          justifyItems: 'center',
        }}
      >
        {tiles.map((tile, i) => (
          <IconTile key={tile.label} {...tile} delay={40 + i * 9} size={100} />
        ))}
      </div>

      <div
        style={{
          opacity: footerSpring,
          transform: `translateY(${interpolate(footerSpring, [0, 1], [16, 0])}px)`,
          textAlign: 'center',
          fontSize: FONT_SIZE.label,
          fontWeight: 700,
          color: COLORS.accent,
          letterSpacing: 1,
        }}
      >
        diamondreport.app
      </div>
    </SafeZone>
  );
};
