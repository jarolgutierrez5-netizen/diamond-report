import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { SafeZone } from './SafeZone';
import { DrawOnPath } from './DrawOnPath';
import { Particles } from './Particles';
import { idleBob } from './motion';
import { ICON_PATHS } from './icons';
import { COLORS, FONT_SIZE, SPRING_CONFIG } from './theme';

const SportIcon: React.FC<{
  pathD: string;
  color: string;
  label: string;
  delay: number;
  bobPhase: number;
  rotate?: boolean;
}> = ({ pathD, color, label, delay, bobPhase, rotate }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: SPRING_CONFIG });
  const draw = interpolate(frame - delay - 6, [0, 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const bob = s >= 0.98 ? idleBob(frame, 10, 0.12, bobPhase) : 0;
  const wobble = rotate && s >= 0.98 ? idleBob(frame, 6, 0.08, bobPhase) : 0;

  return (
    <div
      style={{
        opacity: s,
        transform: `scale(${interpolate(s, [0, 1], [0.6, 1])}) translateY(${bob}px) rotate(${wobble}deg)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18,
      }}
    >
      <div
        style={{
          width: 170,
          height: 170,
          borderRadius: 32,
          background: 'rgba(255,255,255,0.06)',
          border: `2px solid ${COLORS.faint}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width={92} height={92} viewBox="0 0 100 100">
          <DrawOnPath d={pathD} progress={draw} stroke={color} strokeWidth={5} />
        </svg>
      </div>
      <div style={{ fontSize: FONT_SIZE.label, fontWeight: 600, color: COLORS.dim }}>{label}</div>
    </div>
  );
};

export const Scene4ComingSoon: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headlineSpring = spring({ frame, fps, config: SPRING_CONFIG });
  const bodySpring = spring({ frame: frame - 10, fps, config: SPRING_CONFIG });
  const badgeSpring = spring({ frame: frame - 90, fps, config: SPRING_CONFIG });
  const badgePulse = badgeSpring >= 0.98 ? 1 + Math.sin(frame * 0.15) * 0.04 : 1;

  return (
    <SafeZone
      style={{
        background: `linear-gradient(160deg, ${COLORS.bgTop} 0%, ${COLORS.bgBottom} 100%)`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Particles count={9} opacity={0.35} seedPrefix="s4-particle" />

      <div
        style={{
          opacity: headlineSpring,
          transform: `translateY(${interpolate(headlineSpring, [0, 1], [-24, 0])}px)`,
        }}
      >
        <div style={{ fontSize: FONT_SIZE.headline, fontWeight: 800 }}>More Sports. Coming Soon.</div>
      </div>
      <div
        style={{
          marginTop: 22,
          opacity: bodySpring,
          transform: `translateY(${interpolate(bodySpring, [0, 1], [-14, 0])}px)`,
        }}
      >
        <div style={{ fontSize: FONT_SIZE.body, color: COLORS.dim, maxWidth: 880, lineHeight: 1.4 }}>
          We&apos;re building the same data-driven approach for football and basketball next — one edge, more
          sports.
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 56,
        }}
      >
        <div style={{ display: 'flex', gap: 60 }}>
          <SportIcon pathD={ICON_PATHS.football} color="#a3623c" label="Football" delay={44} bobPhase={0} rotate />
          <SportIcon pathD={ICON_PATHS.basketball} color="#fb923c" label="Basketball" delay={54} bobPhase={2.4} />
        </div>

        <div
          style={{
            opacity: badgeSpring,
            transform: `scale(${interpolate(badgeSpring, [0, 1], [0.7, 1]) * badgePulse})`,
            border: `2px solid ${COLORS.accent}`,
            borderRadius: 999,
            padding: '14px 36px',
            background: 'rgba(34,197,94,0.1)',
          }}
        >
          <span style={{ fontSize: FONT_SIZE.label, fontWeight: 700, color: COLORS.accent, letterSpacing: 1 }}>
            SOON
          </span>
        </div>
      </div>
    </SafeZone>
  );
};
