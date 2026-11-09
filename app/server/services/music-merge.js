'use strict';

const DEFAULT_MUSIC_VOLUME = 0.6;

const clampVolume = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_MUSIC_VOLUME;
  return Math.max(0, Math.min(1, number));
};

const buildMusicFilter = (music) => `volume=${clampVolume(music?.volume).toFixed(3)}`;

const buildFinalizeArgs = ({input, output, music = null, durationSec = null}) => {
  if (!music?.file) return ['-y', '-i', input, '-map', '0', '-c', 'copy', '-movflags', '+faststart', output];
  const args = [
    '-y',
    '-i', input,
    '-i', music.file,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    '-af', buildMusicFilter(music)
  ];
  const duration = Number(durationSec);
  if (Number.isFinite(duration) && duration > 0) args.push('-t', duration.toFixed(3));
  else args.push('-shortest');
  args.push('-movflags', '+faststart', output);
  return args;
};

module.exports = {buildFinalizeArgs, buildMusicFilter};
