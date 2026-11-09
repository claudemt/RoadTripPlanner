import {RouteVideoData, VideoDay} from '../types';

const FPS = 30;
const COVER_FRAMES = Math.round(6 * FPS);
const SEGMENT_FRAMES = Math.round(1.5 * FPS);
const ENDPOINT_HOLD_FRAMES = 3 * FPS;
export const OUTRO_MAP_FRAMES = Math.round(2.5 * FPS);
export const OUTRO_PAGE_FRAMES = Math.round(3 * FPS);
export const OUTRO_PAGE_SIZE = 10;

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

export const getCoverFrames = (_data: RouteVideoData) => COVER_FRAMES;
export const getOutroFrames = (data: RouteVideoData) => {
  const pages = Math.max(1, Math.ceil(data.days.length / OUTRO_PAGE_SIZE));
  return OUTRO_MAP_FRAMES + Math.max(OUTRO_PAGE_FRAMES, pages * OUTRO_PAGE_FRAMES);
};

export const buildTimeline = (data: RouteVideoData): DayTiming[] => {
  let cursor = getCoverFrames(data);
  return data.days.map((day, dayIndex) => {
    const duration = getDayDurationFrames(day);
    const timing = {dayIndex, start: cursor, duration, end: cursor + duration};
    cursor += duration;
    return timing;
  });
};

export const getTotalDuration = (data: RouteVideoData) => {
  return getCoverFrames(data) + data.days.reduce((sum, day) => sum + getDayDurationFrames(day), 0) + getOutroFrames(data);
};

export const findActiveTiming = (frame: number, data: RouteVideoData) => buildTimeline(data).find((timing) => frame >= timing.start && frame < timing.end);

const formatDistance = (meters: number) => {
  if (!meters) return '0km';
  const km = meters / 1000;
  return `${km >= 100 ? km.toFixed(0) : km.toFixed(1)}km`;
};

const formatDuration = (seconds: number) => {
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
