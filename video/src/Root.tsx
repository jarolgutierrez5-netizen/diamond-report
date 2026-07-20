import React from 'react';
import { Composition } from 'remotion';
import { PicksOfTheDay } from './PicksOfTheDay';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="PicksOfTheDay"
      component={PicksOfTheDay}
      durationInFrames={150}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{
        picks: [
          { player: 'Sample Player A', market: 'HR', line: '+120' },
          { player: 'Sample Player B', market: 'TB', line: 'o1.5' },
          { player: 'Sample Player C', market: 'K', line: 'o5.5' },
        ],
      }}
    />
  );
};
