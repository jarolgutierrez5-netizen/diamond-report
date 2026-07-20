import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export type Pick = {
  player: string;
  market: string;
  line: string;
};

export const PicksOfTheDay: React.FC<{ picks: Pick[] }> = ({ picks }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(160deg, #070c14 0%, #0d1a2b 100%)',
        fontFamily: 'Arial, sans-serif',
        color: '#fff',
        padding: 80,
      }}
    >
      <div style={{ opacity: titleOpacity, fontSize: 64, fontWeight: 800 }}>
        Today's Picks
      </div>
      {picks.map((pick, i) => {
        const delay = 20 + i * 15;
        const s = spring({ frame: frame - delay, fps, config: { damping: 14 } });
        const translateY = interpolate(s, [0, 1], [40, 0]);
        return (
          <div
            key={pick.player}
            style={{
              opacity: s,
              transform: `translateY(${translateY}px)`,
              marginTop: 36,
              fontSize: 40,
              display: 'flex',
              justifyContent: 'space-between',
              borderBottom: '2px solid rgba(255,255,255,0.15)',
              paddingBottom: 16,
            }}
          >
            <span>{pick.player}</span>
            <span style={{ color: '#4fd1c5' }}>
              {pick.market} {pick.line}
            </span>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
