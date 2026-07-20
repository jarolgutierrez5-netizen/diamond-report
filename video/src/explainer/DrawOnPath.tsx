import React from 'react';

// Uses the SVG `pathLength` normalization trick so stroke-dashoffset draw-on
// animation works for any path shape without measuring real geometry.
export const DrawOnPath: React.FC<{
  d: string;
  progress: number;
  stroke: string;
  strokeWidth?: number;
  fill?: string;
  fillOpacity?: number;
}> = ({ d, progress, stroke, strokeWidth = 5, fill = 'none', fillOpacity }) => (
  <path
    d={d}
    pathLength={1}
    stroke={stroke}
    strokeWidth={strokeWidth}
    fill={fill}
    fillOpacity={fillOpacity}
    strokeDasharray={1}
    strokeDashoffset={1 - progress}
    strokeLinecap="round"
    strokeLinejoin="round"
  />
);
