import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { SafeZone } from './SafeZone';
import { DrawOnPath } from './DrawOnPath';
import { CountUp } from './CountUp';
import { Particles } from './Particles';
import { idlePulse } from './motion';
import { ICON_PATHS } from './icons';
import { COLORS, FONT_SIZE, SPRING_CONFIG } from './theme';

const RankedRow: React.FC<{ rank: number; name: string; score: number; color: string; delay: number }> = ({
  rank,
  name,
  score,
  color,
  delay,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: SPRING_CONFIG });

  return (
    <div
      style={{
        opacity: s,
        transform: `translateX(${interpolate(s, [0, 1], [-24, 0])}px)`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        borderBottom: `1px solid ${COLORS.faint}`,
        paddingBottom: 10,
        marginTop: 18,
      }}
    >
      <span style={{ fontSize: FONT_SIZE.label, fontWeight: 600, color: COLORS.text }}>
        {rank}. {name}
      </span>
      <CountUp
        to={score}
        startFrame={delay}
        durationInFrames={16}
        style={{ fontSize: FONT_SIZE.label, fontWeight: 800, color }}
      />
    </div>
  );
};

export const Scene3Threats: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headlineSpring = spring({ frame, fps, config: SPRING_CONFIG });
  const bodySpring = spring({ frame: frame - 10, fps, config: SPRING_CONFIG });

  const flameDraw = interpolate(frame - 38, [0, 20], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const kSpring = spring({ frame: frame - 38, fps, config: SPRING_CONFIG });
  const flameFlicker = flameDraw >= 1 ? idlePulse(frame, 0.06, 0.25) : 1;
  const kPulse = kSpring >= 0.98 ? idlePulse(frame, 0.05, 0.18, 3) : 1;

  return (
    <SafeZone
      style={{
        background: `linear-gradient(160deg, ${COLORS.bgTop} 0%, ${COLORS.bgBottom} 100%)`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Particles count={7} opacity={0.3} seedPrefix="s3-particle" />

      <div
        style={{
          opacity: headlineSpring,
          transform: `translateY(${interpolate(headlineSpring, [0, 1], [-24, 0])}px)`,
        }}
      >
        <div style={{ fontSize: FONT_SIZE.headline, fontWeight: 800 }}>Power &amp; Punchouts</div>
      </div>
      <div
        style={{
          marginTop: 22,
          opacity: bodySpring,
          transform: `translateY(${interpolate(bodySpring, [0, 1], [-14, 0])}px)`,
        }}
      >
        <div style={{ fontSize: FONT_SIZE.body, color: COLORS.dim, maxWidth: 880, lineHeight: 1.4 }}>
          HR Threats ranks hitters most likely to go deep today. K Props ranks pitchers most likely to hit their
          strikeout total.
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', gap: 44, alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <svg
              width={56}
              height={56}
              viewBox="0 0 100 100"
              style={{ transform: `scale(${flameFlicker})` }}
            >
              <DrawOnPath d={ICON_PATHS.flame} progress={flameDraw} stroke="#f97316" strokeWidth={7} />
            </svg>
            <span style={{ fontSize: FONT_SIZE.body, fontWeight: 700 }}>HR Threats</span>
          </div>
          <RankedRow rank={1} name="Player A" score={82} color="#f97316" delay={64} />
          <RankedRow rank={2} name="Player B" score={76} color="#f97316" delay={76} />
          <RankedRow rank={3} name="Player C" score={71} color="#f97316" delay={88} />
        </div>

        <div style={{ width: 1, alignSelf: 'stretch', background: COLORS.faint }} />

        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              style={{
                fontSize: 44,
                fontWeight: 800,
                color: '#38bdf8',
                opacity: kSpring,
                transform: `scale(${interpolate(kSpring, [0, 1], [0.6, 1]) * kPulse})`,
              }}
            >
              K
            </div>
            <span style={{ fontSize: FONT_SIZE.body, fontWeight: 700 }}>K Props</span>
          </div>
          <RankedRow rank={1} name="Pitcher A" score={79} color="#38bdf8" delay={64} />
          <RankedRow rank={2} name="Pitcher B" score={74} color="#38bdf8" delay={76} />
          <RankedRow rank={3} name="Pitcher C" score={68} color="#38bdf8" delay={88} />
        </div>
      </div>
    </SafeZone>
  );
};
