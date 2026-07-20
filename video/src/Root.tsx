import React from 'react';
import { Composition } from 'remotion';
import { PicksOfTheDay } from './PicksOfTheDay';
import { WeeklyRecap } from './WeeklyRecap';
import { TodaysPicksExplainer, TODAYS_PICKS_EXPLAINER_DURATION } from './TodaysPicksExplainer';

export const RemotionRoot: React.FC = () => {
  return (
    <>
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
      <Composition
        id="WeeklyRecap"
        component={WeeklyRecap}
        durationInFrames={270}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          rangeLabel: 'Sample range',
          markets: [
            { label: 'Moneyline (DRP)', wins: 0, losses: 0, winPct: 0 },
            { label: 'K Props', wins: 0, losses: 0, winPct: 0 },
            { label: 'Elite Picks', wins: 0, losses: 0, winPct: 0 },
            { label: 'HR Threats', wins: 0, losses: 0, winPct: 0 },
          ],
          overallWins: 0,
          overallLosses: 0,
          overallWinPct: 0,
        }}
      />
      <Composition
        id="TodaysPicksExplainer"
        component={TodaysPicksExplainer}
        durationInFrames={TODAYS_PICKS_EXPLAINER_DURATION}
        fps={30}
        width={1080}
        height={1920}
      />
    </>
  );
};
