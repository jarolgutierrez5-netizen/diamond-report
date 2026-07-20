import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export type MarketStat = {
  label: string;
  wins: number;
  losses: number;
  winPct: number;
};

export type WeeklyRecapProps = {
  rangeLabel: string;
  markets: MarketStat[];
  overallWins: number;
  overallLosses: number;
  overallWinPct: number;
};

const ACCENT = '#4fd1c5';
const BG_TOP = '#070c14';
const BG_BOTTOM = '#0d1a2b';

const Bar: React.FC<{ stat: MarketStat; index: number }> = ({ stat, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const delay = 45 + index * 22;

  const enter = spring({ frame: frame - delay, fps, config: { damping: 16 } });
  const translateY = interpolate(enter, [0, 1], [30, 0]);
  const fillFrame = frame - delay - 8;
  const fillProgress = interpolate(fillFrame, [0, 25], [0, stat.winPct], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        opacity: enter,
        transform: `translateY(${translateY}px)`,
        marginTop: 44,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          fontSize: 34,
          color: '#fff',
          marginBottom: 10,
        }}
      >
        <span style={{ fontWeight: 700 }}>{stat.label}</span>
        <span style={{ color: ACCENT, fontWeight: 800 }}>
          {stat.wins}-{stat.losses}{' '}
          <span style={{ color: 'rgba(255,255,255,0.55)', fontWeight: 500, fontSize: 26 }}>
            ({Math.round(fillProgress)}%)
          </span>
        </span>
      </div>
      <div
        style={{
          height: 22,
          borderRadius: 11,
          background: 'rgba(255,255,255,0.08)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${fillProgress}%`,
            borderRadius: 11,
            background: `linear-gradient(90deg, ${ACCENT}, #2f9e93)`,
          }}
        />
      </div>
    </div>
  );
};

export const WeeklyRecap: React.FC<WeeklyRecapProps> = ({
  rangeLabel,
  markets,
  overallWins,
  overallLosses,
  overallWinPct,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const headerOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const headerY = interpolate(frame, [0, 20], [-20, 0], {
    extrapolateRight: 'clamp',
  });

  const footerDelay = 45 + markets.length * 22 + 20;
  const footerSpring = spring({
    frame: frame - footerDelay,
    fps,
    config: { damping: 16 },
  });

  const outroStart = durationInFrames - 20;
  const outroOpacity = interpolate(
    frame,
    [outroStart, durationInFrames],
    [1, 0.85],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(160deg, ${BG_TOP} 0%, ${BG_BOTTOM} 100%)`,
        fontFamily: 'Arial, sans-serif',
        color: '#fff',
        padding: '90px 80px',
        opacity: outroOpacity,
      }}
    >
      <div style={{ opacity: headerOpacity, transform: `translateY(${headerY}px)` }}>
        <div style={{ fontSize: 30, color: ACCENT, fontWeight: 700, letterSpacing: 2 }}>
          DIAMOND REPORT
        </div>
        <div style={{ fontSize: 60, fontWeight: 800, marginTop: 8 }}>Weekly Recap</div>
        <div style={{ fontSize: 30, color: 'rgba(255,255,255,0.6)', marginTop: 6 }}>
          {rangeLabel}
        </div>
      </div>

      <div style={{ marginTop: 30 }}>
        {markets.map((m, i) => (
          <Bar key={m.label} stat={m} index={i} />
        ))}
      </div>

      <div
        style={{
          position: 'absolute',
          left: 80,
          right: 80,
          bottom: 100,
          opacity: footerSpring,
          transform: `translateY(${interpolate(footerSpring, [0, 1], [24, 0])}px)`,
        }}
      >
        <div
          style={{
            borderTop: '2px solid rgba(255,255,255,0.15)',
            paddingTop: 26,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
          }}
        >
          <span style={{ fontSize: 32, color: 'rgba(255,255,255,0.75)' }}>
            Overall this week
          </span>
          <span style={{ fontSize: 44, fontWeight: 800, color: ACCENT }}>
            {overallWins}-{overallLosses} ({overallWinPct}%)
          </span>
        </div>
        <div
          style={{
            marginTop: 24,
            fontSize: 26,
            color: 'rgba(255,255,255,0.45)',
          }}
        >
          diamondreport.app
        </div>
      </div>
    </AbsoluteFill>
  );
};
