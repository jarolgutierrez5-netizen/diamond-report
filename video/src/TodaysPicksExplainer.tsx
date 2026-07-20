import React from 'react';
import { Audio, Loop, staticFile } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { Scene1Intro } from './explainer/Scene1Intro';
import { Scene2DRP } from './explainer/Scene2DRP';
import { Scene3Threats } from './explainer/Scene3Threats';
import { Scene4ComingSoon } from './explainer/Scene4ComingSoon';
import { Scene5Logo } from './explainer/Scene5Logo';

// Loop is one 120-frame (4s @ 30fps) bar of the generated drum beat — see
// video/scripts/generate-beat.mjs. Total video is 900 frames (30s @ 30fps).
const MUSIC_LOOP_FRAMES = 120;
const TOTAL_FRAMES = 900;
const TRANSITION_FRAMES = 12;

// Individual scene durations sum to TOTAL_FRAMES + 4 * TRANSITION_FRAMES,
// since TransitionSeries overlaps each transition into the adjacent scenes.
const SCENE_FRAMES = [158, 190, 190, 190, 220];

export const TodaysPicksExplainer: React.FC = () => {
  return (
    <>
      <Loop durationInFrames={MUSIC_LOOP_FRAMES}>
        <Audio src={staticFile('music.mp3')} volume={0.3} />
      </Loop>

      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES[0]}>
          <Scene1Intro />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
        />
        <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES[1]}>
          <Scene2DRP />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
        />
        <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES[2]}>
          <Scene3Threats />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
        />
        <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES[3]}>
          <Scene4ComingSoon />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
        />
        <TransitionSeries.Sequence durationInFrames={SCENE_FRAMES[4]}>
          <Scene5Logo />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </>
  );
};

export const TODAYS_PICKS_EXPLAINER_DURATION = TOTAL_FRAMES;
