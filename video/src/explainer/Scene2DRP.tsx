import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { SafeZone } from './SafeZone';
import { DrawOnPath } from './DrawOnPath';
import { CountUp } from './CountUp';
import { Particles } from './Particles';
import { idlePulse } from './motion';
import { ICON_PATHS } from './icons';
import { COLORS, FONT_SIZE, SPRING_CONFIG } from './theme';

export const Scene2DRP: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headlineSpring = spring({ frame, fps, config: SPRING_CONFIG });
  const bodySpring = spring({ frame: frame - 10, fps, config: SPRING_CONFIG });
  const diagramSpring = spring({ frame: frame - 40, fps, config: SPRING_CONFIG });

  const drawProgress = interpolate(frame - 46, [0, 24], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const barFrame = frame - 70;
  const awayPct = interpolate(barFrame, [0, 30], [50, 58], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const homePct = 100 - awayPct;
  const diamondPulse = drawProgress >= 1 ? idlePulse(frame, 0.04, 0.09) : 1;

  return (
    <SafeZone
      style={{
        background: `linear-gradient(160deg, ${COLORS.bgTop} 0%, ${COLORS.bgBottom} 100%)`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Particles count={7} opacity={0.3} seedPrefix="s2-particle" />

      <div
        style={{
          opacity: headlineSpring,
          transform: `translateY(${interpolate(headlineSpring, [0, 1], [-24, 0])}px)`,
        }}
      >
        <div style={{ fontSize: FONT_SIZE.headline, fontWeight: 800 }}>Who Wins Tonight?</div>
      </div>
      <div
        style={{
          marginTop: 22,
          opacity: bodySpring,
          transform: `translateY(${interpolate(bodySpring, [0, 1], [-14, 0])}px)`,
        }}
      >
        <div style={{ fontSize: FONT_SIZE.body, color: COLORS.dim, maxWidth: 880, lineHeight: 1.4 }}>
          The Daily Run Predictor simulates each matchup — pitching, lineups, ballpark, weather — into a win
          percentage for every game.
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 40 }}>
        <div
          style={{
            opacity: diagramSpring,
            transform: `scale(${interpolate(diagramSpring, [0, 1], [0.85, 1]) * diamondPulse})`,
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <svg width={140} height={140} viewBox="0 0 100 100">
            <DrawOnPath d={ICON_PATHS.diamond} progress={drawProgress} stroke={COLORS.accent} strokeWidth={6} />
          </svg>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: FONT_SIZE.body, fontWeight: 700 }}>
          <span>AWAY</span>
          <span>HOME</span>
        </div>
        <div
          style={{
            height: 34,
            borderRadius: 17,
            background: 'rgba(255,255,255,0.08)',
            display: 'flex',
            overflow: 'hidden',
          }}
        >
          <div style={{ width: `${awayPct}%`, background: COLORS.accent }} />
          <div style={{ width: `${homePct}%`, background: 'rgba(255,255,255,0.25)' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <CountUp
            to={58}
            startFrame={70}
            durationInFrames={30}
            suffix="%"
            style={{ fontSize: FONT_SIZE.headline, fontWeight: 800, color: COLORS.accent }}
          />
          <CountUp
            to={42}
            startFrame={70}
            durationInFrames={30}
            suffix="%"
            style={{ fontSize: FONT_SIZE.headline, fontWeight: 800, color: COLORS.dim }}
          />
        </div>
      </div>
    </SafeZone>
  );
};
