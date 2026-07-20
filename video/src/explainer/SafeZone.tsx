import React from 'react';
import { AbsoluteFill } from 'remotion';
import { COLORS, FONT_FAMILY, SAFE } from './theme';

export const SafeZone: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <AbsoluteFill
    style={{
      paddingTop: SAFE.top,
      paddingBottom: SAFE.bottom,
      paddingLeft: SAFE.side,
      paddingRight: SAFE.side,
      boxSizing: 'border-box',
      fontFamily: FONT_FAMILY,
      color: COLORS.text,
      ...style,
    }}
  >
    {children}
  </AbsoluteFill>
);
