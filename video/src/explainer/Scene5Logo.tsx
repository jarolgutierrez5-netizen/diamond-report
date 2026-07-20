import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { SafeZone } from './SafeZone';
import { Particles } from './Particles';
import { Logo } from './Logo';
import { idlePulse } from './motion';
import { COLORS, FONT_SIZE, SPRING_CONFIG } from './theme';

export const Scene5Logo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headlineSpring = spring({ frame, fps, config: SPRING_CONFIG });
  const bodySpring = spring({ frame: frame - 12, fps, config: SPRING_CONFIG });
  const logoGlow = frame >= 90 ? idlePulse(frame, 0.05, 0.09) : 1;

  return (
    <SafeZone
      style={{
        background: `linear-gradient(160deg, ${COLORS.bgTop} 0%, ${COLORS.bgBottom} 100%)`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Particles count={16} seedPrefix="s5-particle" />

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

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ transform: `scale(${logoGlow})` }}>
          <Logo scale={1.7} delay={40} />
        </div>
      </div>
    </SafeZone>
  );
};
