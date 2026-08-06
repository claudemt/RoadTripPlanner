import {RouteVideoData, VideoDay} from '../types';

export const FPS = 30;
export const COVER_FRAMES = 3 * FPS;
export const SEGMENT_FRAMES = Math.round(1.5 * FPS);
export const ENDPOINT_HOLD_FRAMES = 3 * FPS;
export const OUTRO_FRAMES = 3 * FPS;

export type DayTiming = {
  dayIndex: number;
  start: number;
  duration: number;
  end: number;
};

export const dayDistance = (day: VideoDay) => day.segments.reduce((sum, seg) => sum + (seg.distance || 0), 0);
export const dayDurationSeconds = (day: VideoDay) => day.segments.reduce((sum, seg) => sum + (seg.duration || 0), 0);

export const getDayRouteFrames = (day: VideoDay) =>
  Math.max(1, day.points.length - 1, day.segments.length) * SEGMENT_FRAMES;
export const getDayDurationFrames = (day: VideoDay) => getDayRouteFrames(day) + ENDPOINT_HOLD_FRAMES;

export const getRenderSpeed = (data: RouteVideoData) => Math.max(0.25, Number(data.renderSpeed || 1) || 1);
export const getCoverFrames = (_data: RouteVideoData) => COVER_FRAMES;
export const getOutroFrames = (_data: RouteVideoData) => OUTRO_FRAMES;
export const getMinDayFrames = (_data: RouteVideoData) => 0;

export const buildTimeline = (data: RouteVideoData): DayTiming[] => {
  let cursor = getCoverFrames(data);
  return data.days.map((day, dayIndex) => {
    const duration = Math.max(getMinDayFrames(data), getDayDurationFrames(day));
    const timing = {dayIndex, start: cursor, duration, end: cursor + duration};
    cursor += duration;
    return timing;
  });
};

export const getTotalDuration = (data: RouteVideoData) => {
  return getCoverFrames(data) + data.days.reduce((sum, day) => sum + getDayDurationFrames(day), 0) + getOutroFrames(data);
};

export const findActiveTiming = (frame: number, data: RouteVideoData) => buildTimeline(data).find((timing) => frame >= timing.start && frame < timing.end);

export const formatDistance = (meters: number) => {
  if (!meters) return '0km';
  const km = meters / 1000;
  return `${km >= 100 ? km.toFixed(0) : km.toFixed(1)}km`;
};

export const formatDuration = (seconds: number) => {
  if (!seconds) return '0min';
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h${rest ? `${rest}min` : ''}` : `${rest}min`;
};

export const formatTripMetric = (meters: number, seconds: number) => `${formatDistance(meters)}/${formatDuration(seconds)}`;

export const cleanText = (value: string, max = 86) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
