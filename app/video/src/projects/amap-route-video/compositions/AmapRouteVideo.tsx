import React from 'react';
import {AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {AMapFixedBackdrop, fallbackBackground} from '../components/AMapFixedBackdrop';
import {routeFont, useRouteFont} from '../lib/font';
import {computeCamera, cumulativePointProgress, dayPath, daySegmentPaths, layoutPointLabels, markerScale, pointScale, sampleDayPath, segmentRevealFractions, svgPath, LabelBox} from '../lib/geo';
import {cleanText, dayDistance, dayDurationSeconds, findActiveTiming, formatTripMetric, getCoverFrames, getDayRouteFrames, getOutroFrames, getTotalDuration, OUTRO_MAP_FRAMES, OUTRO_PAGE_SIZE} from '../lib/timeline';
import {RouteVideoData, ScenicInfo, VideoDay, VideoPoint} from '../types';
import weatherCodeMap from '../../../../../shared/weather-codes.json';

type Props = {
  data: RouteVideoData;
  amapKey?: string;
  amapSecurityCode?: string;
};

type LabelMode = 'none' | 'endpoints' | 'all';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const safeAsset = (src: string) => {
  const value = String(src || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return /^(https?:|data:)/i.test(value) ? value : staticFile(value);
};
const stripDayPrefix = (value: string) =>
  String(value || '')
    .replace(/^\s*D\s*\d+\s*[：:、.．-]?\s*/i, '')
    .replace(/\s*[;；,，、-]?\s*\d+(?:\.\d+)?\s*h(?:\s*[（(]\s*\d+(?:\.\d+)?\s*h\s*[）)])?\s*$/i, '')
    .trim();

const colors = {
  cyan: '#20d9ff',
  blue: '#1677ff',
  orange: '#ffb000',
  green: '#31d987',
  red: '#ff4d5d',
  dark: '#07111f',
};
const HUD_RECT = {x: 52, y: 38, width: 1140, height: 120};

const styles: Record<string, React.CSSProperties> = {
  font: {fontFamily: routeFont, color: 'white'},
};

const pointColor = (point: VideoPoint, fallback: string) => fallback;

const weatherMeta = (code: number) => {
  return (weatherCodeMap as Record<string, {label: string; icon: string}>)[String(code)] || {label: '未知天气', icon: 'cloudy'};
};
const pointFacts = (point: VideoPoint, data: RouteVideoData) => {
  const values: string[] = [];
  if (data.presentation?.weather && point.weather) values.push(`${weatherMeta(point.weather.code).label} · ${Math.round(point.weather.minC)}–${Math.round(point.weather.maxC)} °C`);
  if (data.presentation?.elevation && Number.isFinite(Number(point.elevationM))) values.push(`${Math.round(Number(point.elevationM) / 10) * 10} m`);
  return values.join(' · ');
};

const pointRouteFacts = (day: VideoDay, pointIndex: number, data: RouteVideoData) => {
  if (data.presentation?.routeFacts !== true || pointIndex <= 0) return '';
  let distance = 0;
  let duration = 0;
  for (let i = 0; i < Math.min(pointIndex, day.segments.length); i += 1) {
    const segment = day.segments[i];
    distance += Number(segment?.distance || 0);
    duration += Number(segment?.duration || 0);
  }
  if (!(distance > 0)) return '';
  const km = Math.round(distance / 1000);
  const hours = Math.floor(duration / 3600);
  const minutes = Math.max(1, Math.round((duration % 3600) / 60));
  return hours > 0 ? `${km}km/${hours}h${String(minutes).padStart(2, '0')}min` : `${km}km/${minutes}min`;
};

const isSamePoint = (left: VideoPoint | undefined, right: VideoPoint | undefined) => {
  if (!left || !right) return false;
  const leftName = String(left.name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const rightName = String(right.name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return Boolean(leftName && leftName === rightName)
    && Math.abs(Number(left.lng) - Number(right.lng)) <= 0.000001
    && Math.abs(Number(left.lat) - Number(right.lat)) <= 0.000001;
};

const placeKey = (point: VideoPoint | undefined) => String(point?.name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

const isLabelSuperseded = (
  data: RouteVideoData,
  dayIndex: number,
  pointIndex: number,
  activeDayIndex: number | null
) => {
  if (activeDayIndex === null) return false;
  const key = placeKey(data.days[dayIndex].points[pointIndex]);
  if (!key) return false;
  for (let d = dayIndex + 1; d < data.days.length; d += 1) {
    const day = data.days[d];
    for (let p = 0; p < day.points.length; p += 1) {
      if (placeKey(day.points[p]) !== key) continue;
      if (d <= activeDayIndex) return true;
    }
  }
  return false;
};

const PointMarker: React.FC<{data: RouteVideoData; point: VideoPoint; x: number; y: number; color: string; visible: boolean; labelMode: LabelMode; labelText?: string; labelBox?: LabelBox; revealFrame?: number | null; suppressLabel?: boolean; routeFactsLine?: string}> = ({data, point, x, y, color, visible, labelMode, labelText, labelBox, revealFrame = null, suppressLabel = false, routeFactsLine = ''}) => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  const pop = revealFrame === null ? 1 : clamp((frame - revealFrame) / 6, 0, 1);
  const showLabel = !suppressLabel && (labelMode === 'all' || (labelMode === 'endpoints' && (point.kind === 'from' || point.kind === 'to')));
  const labelOffset = point.labelOffset || {x: 0, y: 0};
  const scale = pointScale(data, width, height);
  const pin = markerScale(data, width, height);
  const markerWidth = 38 * pin;
  const markerHeight = 52 * pin;
  if (!visible) return null;
  const facts = pointFacts(point, data);
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: `translate(-50%, -100%) scale(${1.42 - pop * 0.42})`, transformOrigin: '50% 100%', zIndex: 40}}>
      <div style={{position: 'relative', width: markerWidth, height: markerHeight, filter: 'drop-shadow(0 8px 12px rgba(0,0,0,.45))'}}>
        <svg width={markerWidth} height={markerHeight} viewBox="0 0 38 52">
          <path d="M19 2C9.6 2 2 9.7 2 19.1c0 13 17 30.9 17 30.9s17-17.9 17-30.9C36 9.7 28.4 2 19 2z" fill={color} stroke="white" strokeWidth="2.5" />
          <circle cx="19" cy="19" r="10" fill="white" opacity=".96" />
          <text x="19" y="23" textAnchor="middle" fontSize="13" fontWeight="900" fill={color} fontFamily={routeFont}>{point.role}</text>
        </svg>
      </div>
      {showLabel ? (
        <div
          style={{
            position: 'absolute',
            left: labelBox ? labelBox.x - (x - markerWidth / 2) : 34 * scale + labelOffset.x * width,
            top: labelBox ? labelBox.y - (y - markerHeight) : -4 * scale + labelOffset.y * height,
            width: labelBox?.width,
            boxSizing: 'border-box',
            overflow: 'hidden',
            padding: `${5 * scale}px ${8 * scale}px`,
            borderRadius: 6 * scale,
            background: 'rgba(255,255,255,.98)',
            color,
            fontSize: 17 * scale,
            lineHeight: 1.08,
            fontWeight: 900,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            boxShadow: '0 7px 16px rgba(0,0,0,.28)',
            border: `${Math.max(1, scale)}px solid ${color}`,
            textShadow: '0 1px 0 rgba(255,255,255,.9)',
          }}
        >
          <div>{labelText || point.name}</div>
          {facts ? <div style={{display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, color, fontSize: 13 * scale}}>{data.presentation?.weather && point.weather ? <Img src={staticFile(`weather/${weatherMeta(point.weather.code).icon}.svg`)} style={{width: 18 * scale, height: 18 * scale}} /> : null}<span>{facts}</span></div> : null}
          {routeFactsLine ? <div style={{marginTop: 2, color, fontSize: 14 * scale, fontWeight: 800, whiteSpace: 'nowrap'}}>{routeFactsLine}</div> : null}
        </div>
      ) : null}
    </div>
  );
};

const SCENIC_CARD_WIDTH = 660;
const SCENIC_CARD_PADDING = 14;
const SCENIC_TEXT_WIDTH = SCENIC_CARD_WIDTH - SCENIC_CARD_PADDING * 2;
const SCENIC_IMAGE_GAP = 10;
const SCENIC_IMAGE_WIDTH = Math.round((SCENIC_TEXT_WIDTH - SCENIC_IMAGE_GAP) / 2);
const SCENIC_BAND_TWO = Math.round((SCENIC_IMAGE_WIDTH * 9) / 16);
const SCENIC_BAND_ONE = 205;
const SCENIC_BAND_GAP = 12;
const SCENIC_TITLE_SIZE = 30;
const SCENIC_DESC_SIZE = 24;
const SCENIC_DESC_MAX = 100;
const SCENIC_MARGIN = 42;
const SCENIC_TOP = 205;
const SCENIC_GAP = 14;
const SCENIC_BOTTOM = 30;
const SCENIC_ENTER_DISTANCE = 56;

const measureTextLines = (text: string, fontSize: number, maxWidth: number) => {
  const characters = Array.from(String(text || ''));
  let lines = 1;
  let width = 0;
  characters.forEach((character) => {
    const charWidth = /[\u0000-\u00ff]/.test(character) ? fontSize * 0.55 : fontSize;
    if (width + charWidth > maxWidth) {
      lines += 1;
      width = charWidth;
      return;
    }
    width += charWidth;
  });
  return lines;
};

const scenicCardMetrics = (spot: ScenicInfo) => {
  const images = (spot.images || []).filter((value) => Boolean(value)).slice(0, 2);
  const title = cleanText(spot.title || spot.name || '景点介绍', 22);
  const description = cleanText(spot.description || '暂无介绍', SCENIC_DESC_MAX);
  const band = images.length >= 2 ? SCENIC_BAND_TWO : images.length === 1 ? SCENIC_BAND_ONE : 0;
  const lines = measureTextLines(description, SCENIC_DESC_SIZE, SCENIC_TEXT_WIDTH);
  const textHeight = SCENIC_TITLE_SIZE * 1.2 + 8 + lines * SCENIC_DESC_SIZE * 1.4;
  const height = Math.round(SCENIC_CARD_PADDING * 2 + band + (band ? SCENIC_BAND_GAP : 0) + textHeight);
  return {images, title, description, band, lines, height};
};

const layoutScenicCards = (revealed: {spot: ScenicInfo; local: number; key: string}[], width: number, height: number) => {
  const limit = height - SCENIC_BOTTOM;
  const columns = [
    {x: SCENIC_MARGIN},
    {x: width - SCENIC_MARGIN - SCENIC_CARD_WIDTH},
  ];
  const cursors = columns.map(() => SCENIC_TOP);
  const placed: {spot: ScenicInfo; local: number; key: string; x: number; y: number; index: number}[] = [];
  revealed.forEach((item) => {
    const {height: cardHeight} = scenicCardMetrics(item.spot);
    for (let column = columns.length - 1; column >= 0; column -= 1) {
      if (cursors[column] + cardHeight > limit) continue;
      placed.push({...item, x: columns[column].x, y: cursors[column], index: placed.length});
      cursors[column] += cardHeight + SCENIC_GAP;
      return;
    }
  });
  return placed;
};

const ScenicCard: React.FC<{spot: ScenicInfo; dayColor: string; progress: number; index: number; x: number; y: number}> = ({spot, dayColor, progress, index, x, y}) => {
  const {images, title, description, band, height} = scenicCardMetrics(spot);
  const local = clamp((progress - index * 0.07) / 0.86, 0, 1);
  const enter = interpolate(local, [0, 0.22, 1], [SCENIC_ENTER_DISTANCE, 0, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const opacity = interpolate(local, [0, 0.16, 1], [0, 1, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const columns = images.length >= 2 ? `${SCENIC_IMAGE_WIDTH}px ${SCENIC_IMAGE_WIDTH}px` : '1fr';
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: SCENIC_CARD_WIDTH,
        height,
        boxSizing: 'border-box',
        opacity,
        transform: enter === 0 ? undefined : `translateX(${enter}px)`,
        borderRadius: 18,
        border: '1px solid rgba(255,255,255,.16)',
        background: 'linear-gradient(118deg, rgba(9,20,34,.97), rgba(13,29,46,.94))',
        boxShadow: '0 24px 64px rgba(0,0,0,.48)',
        padding: SCENIC_CARD_PADDING,
        zIndex: 60,
        overflow: 'hidden',
        textRendering: 'geometricPrecision',
        ...styles.font,
      }}
    >
      {images.length ? (
        <div style={{display: 'grid', gridTemplateColumns: columns, gap: SCENIC_IMAGE_GAP, height: band, background: 'rgba(2,6,14,.6)'}}>
          {images.map((src, imageIndex) => (
            <div key={`${src}-${imageIndex}`} style={{borderRadius: 12, overflow: 'hidden', background: 'rgba(2,6,14,.9)'}}>
              <Img src={safeAsset(src)} delayRenderTimeoutInMilliseconds={45000} delayRenderRetries={2} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
            </div>
          ))}
        </div>
      ) : null}
      <div style={{marginTop: band ? SCENIC_BAND_GAP : 0}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8}}>
          <span style={{width: 7, height: SCENIC_TITLE_SIZE, borderRadius: 99, background: dayColor, boxShadow: `0 0 18px ${dayColor}`}} />
          <div style={{fontSize: SCENIC_TITLE_SIZE, fontWeight: 800, lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{title}</div>
        </div>
        <div style={{fontSize: SCENIC_DESC_SIZE, lineHeight: 1.42, fontWeight: 500, color: 'rgba(255,255,255,.97)', overflow: 'hidden'}}>{description}</div>
      </div>
    </div>
  );
};

const Hud: React.FC<{data: RouteVideoData; day: VideoDay; dayIndex: number; progress: number; fadeIn: number}> = ({data, day, dayIndex, progress, fadeIn}) => {
  const distance = dayDistance(day);
  const duration = dayDurationSeconds(day);
  const metric = formatTripMetric(distance, duration);
  const itinerary = day.points.map((point) => point.name).filter(Boolean).join(" ➡ ");
  return (
    <div
      style={{
        position: 'absolute',
        left: 52,
        top: 38,
        width: 1140,
        minHeight: 88,
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        alignItems: 'center',
        gap: 18,
        padding: '15px 20px',
        borderRadius: 22,
        background: 'linear-gradient(90deg, rgba(7,17,31,.92), rgba(15,23,42,.76))',
        border: '1px solid rgba(255,255,255,.25)',
        boxShadow: '0 18px 54px rgba(0,0,0,.38)',
        ...styles.font,
        opacity: fadeIn,
        zIndex: 75,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
        <div style={{fontSize: 58, lineHeight: 0.92, fontWeight: 1000, color: day.color}}>D{dayIndex + 1}</div>
        <div style={{width: 2, height: 56, background: 'rgba(255,255,255,.22)'}} />
      </div>
      <div style={{minWidth: 0}}>
        <div style={{display: 'flex', alignItems: 'baseline', gap: 14, minWidth: 0}}>
          <div style={{fontSize: 32, fontWeight: 950, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 620}}>{stripDayPrefix(day.title)}</div>
          <div style={{fontSize: 28, fontWeight: 950, color: 'rgba(255,255,255,.9)', whiteSpace: 'nowrap'}}>{metric}</div>
        </div>
        <div style={{fontSize: 28, lineHeight: 1.4, color: 'rgba(255,255,255,.92)', marginTop: 8, overflowWrap: 'anywhere'}}>
          {itinerary}
        </div>
      </div>
    </div>
  );
};

const RouteLayer: React.FC<{data: RouteVideoData; activeDayIndex: number | null; activeProgress: number; camera: ReturnType<typeof computeCamera>}> = ({data, activeDayIndex, activeProgress, camera}) => {
  const {width, height} = useVideoConfig();
  const overview = data.renderMode === 'overview';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{position: 'absolute', inset: 0, overflow: 'visible', zIndex: 20}}>
      <defs>
        <filter id="routeGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {data.days.map((day, dayIndex) => {
        const isPast = activeDayIndex !== null && dayIndex < activeDayIndex;
        const isCurrent = activeDayIndex === dayIndex;
        const isFuture = activeDayIndex !== null && dayIndex > activeDayIndex;
        const reveal = activeDayIndex === null ? 1 : isPast ? 1 : isCurrent ? activeProgress : isFuture ? 1 : 1;
        const reveals = segmentRevealFractions(day, reveal);
        return (
          <g key={dayIndex}>
            {daySegmentPaths(day).map((segment, segmentIndex) => (
              <React.Fragment key={segmentIndex}>
                <path d={svgPath(segment, camera.project)} fill="none" stroke="rgba(0,0,0,.46)" strokeWidth={isCurrent || overview ? 15 : 10} strokeLinecap="round" strokeLinejoin="round" />
                <path
                  d={svgPath(segment, camera.project)}
                  fill="none"
                  stroke={day.color}
                  strokeWidth={isCurrent || overview ? 8 : 5}
                  strokeOpacity={overview ? 0.92 : isFuture ? 0.24 : isCurrent ? 0.96 : 0.68}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  filter={isCurrent && !overview ? 'url(#routeGlow)' : undefined}
                  pathLength={1}
                  strokeDasharray={1}
                  strokeDashoffset={1 - (reveals[segmentIndex] ?? 0)}
                />
              </React.Fragment>
            ))}
          </g>
        );
      })}
    </svg>
  );
};

const routeLabelText = (data: RouteVideoData, dayIndex: number, point: VideoPoint) => {
  if (point.role === '起' && dayIndex > 0 && isSamePoint(data.days[dayIndex - 1]?.points[data.days[dayIndex - 1].points.length - 1], point)) {
    return `D${dayIndex}终&D${dayIndex + 1}起 ${point.name}`;
  }
  return point.role === '起' || point.role === '终'
    ? `D${dayIndex + 1}${point.role} ${point.name}`
    : point.name;
};

const MarkersLayer: React.FC<{data: RouteVideoData; activeDayIndex: number | null; activeProgress: number; camera: ReturnType<typeof computeCamera>; hideLabels?: boolean; activeStart?: number | null; routeFrames?: number | null; revealAvoidRects?: LabelBox[][]}> = ({data, activeDayIndex, activeProgress, camera, hideLabels = false, activeStart = null, routeFrames = null, revealAvoidRects = []}) => {
  const {width, height} = useVideoConfig();
  const revealFrameFor = (dayIndex: number, pointIndex: number, thresholds: number[]) => {
    if (activeDayIndex === null || dayIndex !== activeDayIndex || activeStart === null || routeFrames === null) return null;
    return activeStart + (thresholds[pointIndex] ?? 0) * routeFrames;
  };
  const labelItems = data.days.flatMap((day, dayIndex) => {
    let labelMode: LabelMode = 'none';
    if (activeDayIndex === null) labelMode = hideLabels ? 'none' : 'all';
    else if (dayIndex < activeDayIndex) labelMode = 'endpoints';
    else if (dayIndex === activeDayIndex) labelMode = 'all';
    return day.points.flatMap((point, pointIndex) => {
      if (isLabelSuperseded(data, dayIndex, pointIndex, activeDayIndex)) return [];
      const showLabel = labelMode === 'all' || (labelMode === 'endpoints' && (point.kind === 'from' || point.kind === 'to'));
      if (!showLabel) return [];
      const {x, y} = camera.project([point.lng, point.lat]);
      const key = `${dayIndex}-${pointIndex}-${point.name}`;
      const facts = pointFacts(point, data);
      const routeFactsLine = pointRouteFacts(day, pointIndex, data);
      const text = `${routeLabelText(data, dayIndex, point)}${facts ? `\n${facts}` : ''}${routeFactsLine ? `\n${routeFactsLine}` : ''}`;
      const avoidRects = dayIndex === activeDayIndex ? revealAvoidRects[pointIndex] : undefined;
      return [{key, x, y, text, labelOffset: point.labelOffset, avoidRects}];
    });
  });
  const avoidPaths = data.days.map((day) => dayPath(day).map((coord) => camera.project(coord)));
  const avoidRects = activeDayIndex === null ? [] : [HUD_RECT];
  const labelBoxes = layoutPointLabels(labelItems, width, height, avoidRects, pointScale(data, width, height), avoidPaths, activeDayIndex !== null);
  const frame = useCurrentFrame();
  const dayFadeIn = activeStart === null ? 1 : interpolate(frame - activeStart, [0, 9], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{opacity: dayFadeIn, pointerEvents: 'none'}}>
      {data.days.map((day, dayIndex) => {
        const thresholds = cumulativePointProgress(day);
        let labelMode: LabelMode = 'none';
        if (activeDayIndex === null) labelMode = hideLabels ? 'none' : 'all';
        else if (dayIndex < activeDayIndex) labelMode = 'endpoints';
        else if (dayIndex === activeDayIndex) labelMode = 'all';
        return day.points.map((point, pointIndex) => {
          if (isLabelSuperseded(data, dayIndex, pointIndex, activeDayIndex)) return null;
          const {x, y} = camera.project([point.lng, point.lat]);
          const visible = activeDayIndex === null
            || (dayIndex < activeDayIndex && (point.kind === 'from' || point.kind === 'to'))
            || (dayIndex === activeDayIndex && thresholds[pointIndex] <= activeProgress);
          return (
            <PointMarker
              data={data}
              key={`${dayIndex}-${pointIndex}-${point.name}`}
              point={point}
              x={x}
              y={y}
              color={pointColor(point, day.color)}
              visible={visible}
              labelMode={labelMode}
              labelText={routeLabelText(data, dayIndex, point)}
              routeFactsLine={pointRouteFacts(day, pointIndex, data)}
              labelBox={labelBoxes.get(`${dayIndex}-${pointIndex}-${point.name}`)}
              revealFrame={revealFrameFor(dayIndex, pointIndex, thresholds)}
              suppressLabel={isLabelSuperseded(data, dayIndex, pointIndex, activeDayIndex)}
            />
          );
        });
      })}
    </AbsoluteFill>
  );
};
const Runner: React.FC<{day: VideoDay; progress: number; camera: ReturnType<typeof computeCamera>; scale: number}> = ({day, progress, camera, scale}) => {
  const frame = useCurrentFrame();
  const coord = sampleDayPath(day, progress, camera.project);
  const {x, y} = camera.project(coord);
  const size = 112 * scale;
  const pulse = (frame % 42) / 42;
  return (
    <div style={{position: 'absolute', left: x, top: y, width: size, height: size, transform: 'translate(-50%, -50%)', display: 'grid', placeItems: 'center', pointerEvents: 'none', zIndex: 55}}>

      <div style={{position: 'absolute', inset: 0, borderRadius: '50%', background: `radial-gradient(circle, ${day.color}a8 0%, ${day.color}3d 42%, transparent 72%)`}} />

      <div style={{position: 'absolute', width: size * (0.3 + 0.56 * pulse), height: size * (0.3 + 0.56 * pulse), borderRadius: '50%', border: `${Math.max(1.5, 2 * scale)}px solid ${day.color}`, opacity: 0.55 * (1 - pulse)}} />
      <div style={{position: 'absolute', width: 15 * scale, height: 15 * scale, borderRadius: '50%', background: '#fff', boxShadow: `0 0 ${10 * scale}px ${3 * scale}px ${day.color}, 0 0 ${26 * scale}px ${9 * scale}px ${day.color}80`}} />
    </div>
  );
};
const scenicDedup = (data: RouteVideoData): {suppress: Set<string>; showAtStart: Set<string>} => {
  const counts = new Map<string, number>();
  data.days.forEach((day) => day.points.forEach((point) => {
    if (!point.scenic || !point.name) return;
    counts.set(point.name, (counts.get(point.name) || 0) + 1);
  }));
  const suppress = new Set<string>();
  const showAtStart = new Set<string>();
  for (let i = 0; i < data.days.length - 1; i++) {
    const toPoint = data.days[i].points[data.days[i].points.length - 1];
    const fromPoint = data.days[i + 1].points[0];
    if (toPoint?.scenic && fromPoint && toPoint.name === fromPoint.name && (counts.get(toPoint.name) || 0) > 1 && !suppress.has(toPoint.name)) {
      suppress.add(toPoint.name);
      showAtStart.add(`${i + 1}-0`);
    }
  }
  return {suppress, showAtStart};
};
const scenicStartKeys = (data: RouteVideoData): Set<string> => {
  const keys = new Set<string>();
  (data.scenicPlacements || []).forEach((placement) => {
    if (placement && Number.isInteger(placement.dayIndex) && Number.isInteger(placement.pointIndex)) {
      keys.add(`${placement.dayIndex}-${placement.pointIndex}`);
    }
  });
  return keys;
};
const visualPointsForDay = (data: RouteVideoData, dayIndex: number) => data.days[dayIndex].points;

const CoverBadge: React.FC<{value: string}> = ({value}) => (
  <div style={{padding: '0 30px 0 0', borderRight: '1px solid rgba(219,232,236,.24)', textAlign: 'left'}}>
    <div style={{fontSize: 34, fontWeight: 650, color: '#cfdee3'}}>{value}</div>
  </div>
);


const COVER_PHOTO_TOTAL = 1740;
const COVER_PHOTO_GAP = 26;
const COVER_PHOTO_MAX_GAP = 220;

const coverPhotos = (data: RouteVideoData): {src: string; name: string}[] => {
  const pool: {src: string; name: string; key: string}[] = [];
  const seen = new Set<string>();
  for (const day of data.days) {
    for (const point of day.points) {
      const spot = point.scenic;
      const src = (spot?.images || []).find((value) => Boolean(value));
      const key = String(spot?.name || point.name || "").trim();
      const name = cleanText(spot?.title || key || '', 18);
      if (!src || !name || seen.has(key || name)) continue;
      seen.add(key || name);
      pool.push({src: String(src), name, key});
    }
  }
  const chosen = (Array.isArray(data.coverSpots) ? data.coverSpots : []).map((value) => String(value || "").trim()).filter(Boolean).slice(0, 4);
  if (!chosen.length) return pool.slice(0, 4).map(({src, name}) => ({src, name}));
  const picked: {src: string; name: string}[] = [];
  chosen.forEach((want) => {
    const hit = pool.find((item) => item.key === want) || pool.find((item) => item.name === want)
      || pool.find((item) => item.key.includes(want) || want.includes(item.key));
    if (hit && !picked.some((item) => item.src === hit.src)) picked.push({src: hit.src, name: hit.name});
  });
  return picked.slice(0, 4);
};

const coverTitleSize = (name: string) => (name.length > 22 ? 60 : name.length > 14 ? 74 : 88);

const Cover: React.FC<{data: RouteVideoData; frame: number}> = ({data, frame}) => {
  const {width, height} = useVideoConfig();
  const scale = Math.min(width / 1920, height / 1080);
  const coverFrames = getCoverFrames(data);
  const opacity = interpolate(frame, [0, Math.min(20, coverFrames * 0.35), Math.max(coverFrames - 28, coverFrames * 0.65), coverFrames], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const description = String(data.route.description || "").trim();
  const photos = coverPhotos(data);
  const columns = photos.length;
  const cardWidth = Math.round((COVER_PHOTO_TOTAL - (4 - 1) * COVER_PHOTO_GAP) / 4);
  const photoGap = columns > 1
    ? Math.min(COVER_PHOTO_MAX_GAP, Math.max(COVER_PHOTO_GAP, Math.round((COVER_PHOTO_TOTAL - columns * cardWidth) / (columns - 1))))
    : COVER_PHOTO_GAP;
  const cardHeight = description.length > 160 ? (data.route.name.length > 18 ? 320 : 360) : description && data.route.name.length > 18 ? 400 : 450;
  return (
    <AbsoluteFill style={{opacity, zIndex: 90, background: 'linear-gradient(115deg, rgba(7,19,28,.98), rgba(16,36,45,.90) 56%, rgba(12,29,40,.80))', ...styles.font}}>
      <div style={{position: 'absolute', left: '50%', top: '50%', width: 1920, height: 1080, transform: `translate(-50%, -50%) scale(${scale})`}}>
      <div style={{position: 'absolute', left: 90, top: 88, right: 90}}>
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 50}}>
        <div style={{flex: 1, minWidth: 0, fontSize: coverTitleSize(data.route.name) * 1.35, lineHeight: 1.15, fontWeight: 900, letterSpacing: -2, maxWidth: 1600, color: '#f3f6f4', textShadow: '0 16px 45px rgba(0,0,0,.5)'}}>{data.route.name}</div>
        <div style={{display: 'flex', flexShrink: 0, gap: 30}}>
          <CoverBadge value={`${data.days.length}天`} />
          <CoverBadge value={formatTripMetric(data.summary.totalDistance, data.summary.totalDuration)} />
        </div>
        </div>
        {description ? <div style={{marginTop: 40, maxWidth: 1640, fontSize: description.length > 160 ? 30 : 36, lineHeight: 1.7, letterSpacing: 0.5, fontWeight: 400, color: "#b8cbd3", whiteSpace: "pre-line", overflowWrap: "anywhere"}}>{description}</div> : null}
      </div>
      {photos.length ? (
        <div style={{position: 'absolute', left: '50%', bottom: 90, transform: 'translateX(-50%)', display: 'flex', gap: photoGap, alignItems: 'flex-end'}}>
          {photos.map((photo, index) => {
            const enter = interpolate(frame - index * 6, [0, 18], [30, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
            const photoOpacity = interpolate(frame - index * 6, [0, 18], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
            return (
              <div
                key={`${photo.name}-${index}`}
                style={{
                  position: 'relative',
                  width: cardWidth,
                  height: cardHeight,
                  borderRadius: 14,
                  overflow: 'hidden',
                  border: '1px solid rgba(255,255,255,.16)',
                  boxShadow: '0 26px 60px rgba(0,0,0,.5)',
                  background: 'rgba(7,17,31,.92)',
                  opacity: photoOpacity,
                  transform: `translateY(${enter}px)`,
                }}
              >
                <Img src={safeAsset(photo.src)} delayRenderTimeoutInMilliseconds={45000} delayRenderRetries={2} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
                <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, padding: '50px 26px 26px', background: 'linear-gradient(180deg, rgba(2,6,14,0), rgba(2,6,14,.92))', fontSize: 30, fontWeight: 750, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{photo.name}</div>
              </div>
            );
          })}
        </div>
      ) : null}
      </div>
    </AbsoluteFill>
  );
};

const Outro: React.FC<{data: RouteVideoData; frame: number}> = ({data, frame}) => {
  const {width, height} = useVideoConfig();
  const outroFrames = getOutroFrames(data);
  const local = frame - (getTotalDuration(data) - outroFrames);
  if (local < OUTRO_MAP_FRAMES) return null;
  const textLocal = local - OUTRO_MAP_FRAMES;
  const textFrames = outroFrames - OUTRO_MAP_FRAMES;
  const pageCount = Math.max(1, Math.ceil(data.days.length / OUTRO_PAGE_SIZE));
  const page = Math.min(pageCount - 1, Math.floor(Math.max(0, textLocal) / (textFrames / pageCount)));
  const days = data.days.slice(page * OUTRO_PAGE_SIZE, (page + 1) * OUTRO_PAGE_SIZE);
  const opacity = interpolate(textLocal, [0, 26], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const scale = Math.min(width / 1920, height / 1080);
  return (
    <AbsoluteFill style={{opacity, zIndex: 95, background: 'linear-gradient(115deg, #0a1721, #152b35 65%, #0b1b26)', ...styles.font}}>
      <div style={{position: 'absolute', left: '50%', top: '50%', width: 1920, height: 1080, transform: `translate(-50%, -50%) scale(${scale})`}}>
        <div style={{position: 'absolute', left: 90, right: 90, top: 72, display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 30, borderBottom: '1px solid rgba(218,234,241,.18)'}}>
          <div style={{fontSize: 58, letterSpacing: 2, fontWeight: 900, color: '#f0f5f6'}}>路线与途经点</div>
          <div style={{display: 'flex', gap: 32, color: '#c5d3d8', fontSize: 30, fontWeight: 600}}>
            <span>{data.summary.dayCount}天</span>
            <span>{formatTripMetric(data.summary.totalDistance, data.summary.totalDuration)}</span>
          </div>
        </div>
        <div style={{position: 'absolute', left: 90, right: 90, top: 206, bottom: 70, display: 'grid', gridTemplateRows: `repeat(${Math.max(8, days.length)}, minmax(0, 1fr))`}}>
          {days.map((day, index) => {
            const dayIndex = page * OUTRO_PAGE_SIZE + index;
            const points = visualPointsForDay(data, dayIndex);
            return <div key={dayIndex} style={{display: 'grid', gridTemplateColumns: '104px minmax(0, 1fr) 210px', alignItems: 'center', columnGap: 26, borderBottom: '1px solid rgba(218,234,241,.09)'}}>
              <div style={{fontSize: 40, fontWeight: 900, letterSpacing: -1, color: day.color}}>D{dayIndex + 1}</div>
              <div style={{fontSize: days.length > 8 ? 28 : 32, lineHeight: 1.55, fontWeight: 650, color: '#e8f0f3'}}>
                {points.map((point, pointIndex) => <React.Fragment key={pointIndex}>
                  {pointIndex > 0 ? <span style={{color: '#7d98a5', margin: '0 14px'}}>→</span> : null}
                  <span style={{display: 'inline-block'}}><span style={{color: '#9db2bc', fontSize: '0.72em', marginRight: 7}}>{point.role}</span>{point.name}</span>
                </React.Fragment>)}
              </div>
              <div style={{fontSize: 26, fontWeight: 700, textAlign: 'right', color: '#8fa9b5', letterSpacing: 0.5}}>{formatTripMetric(dayDistance(day), dayDurationSeconds(day))}</div>
            </div>;
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const activeScenics = (day: VideoDay, dayIndex: number, progress: number, thresholds: number[], suppress: Set<string>, showAtStart: Set<string>, startKeys: Set<string>): {spot: ScenicInfo; local: number; key: string}[] => {
  const revealed: {spot: ScenicInfo; local: number; key: string}[] = [];
  for (let index = 0; index < day.points.length; index++) {
    const point = day.points[index];
    if (!point.scenic) continue;
    const atShowStart = showAtStart.has(`${dayIndex}-${index}`) || startKeys.has(`${dayIndex}-${index}`);
    if (point.kind === 'from' && !atShowStart) continue;
    if (suppress.has(point.name) && !atShowStart) continue;
    const t = thresholds[index] ?? 0;
    const isLastPoint = index === day.points.length - 1;
    const revealAt = isLastPoint ? Math.max(0, t - 0.08) : t;
    if (progress < revealAt) continue;
    const local = clamp((progress - revealAt) / 0.08, 0, 1);
    revealed.push({spot: point.scenic, local, key: `${index}-${point.name}`});
  }
  return revealed.slice(-3);
};

export const AmapRouteVideo: React.FC<Props> = ({data, amapKey, amapSecurityCode}) => {
  useRouteFont();
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  const camera = React.useMemo(() => computeCamera(data, width, height), [data, width, height]);
  const active = findActiveTiming(frame, data);
  const activeDayIndex = active ? active.dayIndex : frame < getCoverFrames(data) ? null : data.days.length;
  const activeDay = active ? data.days[active.dayIndex] : null;
  const local = active ? frame - active.start : 0;
  const revealStart = 0;
  const revealEnd = active && activeDay ? Math.min(active.duration, getDayRouteFrames(activeDay)) : 1;
  const activeProgress = active ? interpolate(local, [revealStart, revealEnd], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : 1;
  const thresholds = React.useMemo(() => activeDay ? cumulativePointProgress(activeDay) : [], [activeDay]);
  const dedup = React.useMemo(() => scenicDedup(data), [data]);
  const startKeys = React.useMemo(() => scenicStartKeys(data), [data]);
  const revealedScenics = activeDay ? activeScenics(activeDay, active?.dayIndex ?? 0, activeProgress, thresholds, dedup.suppress, dedup.showAtStart, startKeys) : [];
  const scenics = layoutScenicCards(revealedScenics, width, height);
  const revealAvoidRects = React.useMemo(() => {
    if (!activeDay) return [];
    return thresholds.map((threshold) => {
      const revealed = activeScenics(activeDay, active?.dayIndex ?? 0, threshold, thresholds, dedup.suppress, dedup.showAtStart, startKeys);
      return layoutScenicCards(revealed, width, height).map((scenic) => ({
        x: scenic.x,
        y: scenic.y,
        width: SCENIC_CARD_WIDTH + SCENIC_ENTER_DISTANCE,
        height: scenicCardMetrics(scenic.spot).height,
      }));
    });
  }, [activeDay, active?.dayIndex, thresholds, width, height, dedup, startKeys]);
  const backdrop = (
    <AMapFixedBackdrop
      center={camera.center}
      zoom={camera.zoom}
      mapLayer={data.mapLayer || 'standard'}
      amapKey={amapKey}
      amapSecurityCode={amapSecurityCode}
      staticMapImage={data.staticMapImage}
      hillshade={data.presentation?.hillshade === true}
      hillshadeEndpoint={data.hillshadeEndpoint}
    />
  );

  if (data.renderMode === 'mapOnly') {
    return <AbsoluteFill style={{background: fallbackBackground(data.mapLayer), overflow: 'hidden'}}>{backdrop}</AbsoluteFill>;
  }

  if (data.renderMode === 'overview') {
    return (
      <AbsoluteFill style={{background: fallbackBackground(data.mapLayer), overflow: 'hidden', ...styles.font}}>
        {backdrop}
        <RouteLayer data={data} activeDayIndex={null} activeProgress={1} camera={camera} />
        <MarkersLayer data={data} activeDayIndex={null} activeProgress={1} camera={camera} />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{background: fallbackBackground(data.mapLayer), overflow: 'hidden', ...styles.font}}>
      {backdrop}
      <RouteLayer data={data} activeDayIndex={active ? active.dayIndex : null} activeProgress={activeProgress} camera={camera} />

      <MarkersLayer
        data={data}
        activeDayIndex={active ? active.dayIndex : null}
        activeProgress={activeProgress}
        camera={camera}
        hideLabels={!active && frame < getCoverFrames(data)}
        activeStart={active ? active.start : null}
        routeFrames={active ? revealEnd : null}
        revealAvoidRects={revealAvoidRects}
      />
      {activeDay ? <Runner day={activeDay} progress={activeProgress} camera={camera} scale={pointScale(data, width, height)} /> : null}
      {activeDay && active ? <Hud data={data} day={activeDay} dayIndex={active.dayIndex} progress={activeProgress} fadeIn={interpolate(local, [0, 9], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})} /> : null}
      {scenics.map((scenic) => (
        <ScenicCard key={scenic.key} spot={scenic.spot} dayColor={activeDay?.color || colors.blue} progress={scenic.local} index={scenic.index} x={scenic.x} y={scenic.y} />
      ))}
      <Cover data={data} frame={frame} />
      <Outro data={data} frame={frame} />
    </AbsoluteFill>
  );
};
