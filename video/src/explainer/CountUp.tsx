import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';

export const CountUp: React.FC<{
  from?: number;
  to: number;
  startFrame?: number;
  durationInFrames?: number;
  suffix?: string;
  style?: React.CSSProperties;
}> = ({ from = 0, to, startFrame = 0, durationInFrames = 20, suffix = '', style }) => {
  const frame = useCurrentFrame();
  const value = interpolate(frame, [startFrame, startFrame + durationInFrames], [from, to], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums', ...style }}>
      {Math.round(value)}
      {suffix}
    </span>
  );
};
