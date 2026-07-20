import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { SafeZone } from './SafeZone';
import { DrawOnPath } from './DrawOnPath';
import { CountUp } from './CountUp';
import { ICON_PATHS } from './icons';
import { COLORS, FONT_SIZE, SPRING_CONFIG } from './theme';

const FeederIcon: React.FC<{ pathD?: string; glyph?: string; color: string; delay: number; x: number }> = ({
  pathD,
  glyph,
  color,
  delay,
  x,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: SPRING_CONFIG });
  const fall = interpolate(s, [0, 1], [0, 90]);
  const shrink = interpolate(s, [0, 1], [1, 0.4]);
  const fade = interpolate(s, [0, 0.7, 1], [1, 1, 0]);

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: fall,
        opacity: fade,
        transform: `scale(${shrink})`,
      }}
    >
      <svg width={70} height={70} viewBox="0 0 100 100">
        {pathD ? (
          <DrawOnPath d={pathD} progress={1} stroke={color} strokeWidth={7} />
        ) : (
          <text x="50" y="65" fontSize="60" fontWeight={800} fill={color} textAnchor="middle">
            {glyph}
          </text>
        )}
      </svg>
    </div>
  );
};

export const Scene4Elite: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headlineSpring = spring({ frame, fps, config: SPRING_CONFIG });
  const bodySpring = spring({ frame: frame - 10, fps, config: SPRING_CONFIG });
  const funnelDraw = interpolate(frame - 40, [0, 26], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const badgeSpring = spring({ frame: frame - 96, fps, config: SPRING_CONFIG });

  return (
    <SafeZone
      style={{
        background: `linear-gradient(160deg, ${COLORS.bgTop} 0%, ${COLORS.bgBottom} 100%)`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          opacity: headlineSpring,
          transform: `translateY(${interpolate(headlineSpring, [0, 1], [-24, 0])}px)`,
        }}
      >
        <div style={{ fontSize: FONT_SIZE.headline, fontWeight: 800 }}>The Best of the Best</div>
      </div>
      <div
        style={{
          marginTop: 22,
          opacity: bodySpring,
          transform: `translateY(${interpolate(bodySpring, [0, 1], [-14, 0])}px)`,
        }}
      >
        <div style={{ fontSize: FONT_SIZE.body, color: COLORS.dim, maxWidth: 880, lineHeight: 1.4 }}>
          Elite Picks filters across every market for the single highest-scoring plays of the day — not just one
          board, the whole slate.
        </div>
      </div>

      <div
        style={{
          flex: 1,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ position: 'relative', width: 260, height: 150, marginBottom: 10 }}>
          <FeederIcon pathD={ICON_PATHS.diamond} color={COLORS.accent} delay={44} x={0} />
          <FeederIcon pathD={ICON_PATHS.flame} color="#f97316" delay={54} x={95} />
          <FeederIcon glyph="K" color="#38bdf8" delay={64} x={190} />
        </div>

        <svg width={160} height={160} viewBox="0 0 100 100" style={{ marginTop: -10 }}>
          <DrawOnPath d={ICON_PATHS.funnel} progress={funnelDraw} stroke={COLORS.text} strokeWidth={5} />
        </svg>

        <div
          style={{
            marginTop: 30,
            opacity: badgeSpring,
            transform: `scale(${interpolate(badgeSpring, [0, 1], [0.6, 1])})`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
            background: 'rgba(250,204,21,0.1)',
            border: '2px solid #facc15',
            borderRadius: 24,
            padding: '24px 40px',
          }}
        >
          <svg width={44} height={44} viewBox="0 0 100 100">
            <DrawOnPath d={ICON_PATHS.star} progress={1} stroke="#facc15" strokeWidth={7} fill="#facc15" fillOpacity={0.25} />
          </svg>
          <CountUp
            to={92}
            startFrame={96}
            durationInFrames={24}
            style={{ fontSize: FONT_SIZE.headline, fontWeight: 800, color: '#facc15' }}
          />
          <span style={{ fontSize: FONT_SIZE.label, fontWeight: 600, color: COLORS.dim }}>Elite Score</span>
        </div>
      </div>
    </SafeZone>
  );
};
