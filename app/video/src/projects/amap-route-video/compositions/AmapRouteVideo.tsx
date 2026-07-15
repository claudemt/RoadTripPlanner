import React from 'react';
import {AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {loadFont as loadPlayfair} from '@remotion/google-fonts/PlayfairDisplay';
import {loadFont as loadNotoSansSC} from '@remotion/google-fonts/NotoSansSC';
import {AMapFixedBackdrop} from '../components/AMapFixedBackdrop';
import {computeCamera, cumulativePointProgress, dayPath, samplePath, svgPath} from '../lib/geo';
import {DAY_ROUTE_FRAMES, cleanText, dayDistance, dayDurationSeconds, findActiveTiming, formatTripMetric, getCoverFrames, getOutroFrames, getTotalDuration} from '../lib/timeline';
import {RouteVideoData, ScenicInfo, VideoDay, VideoPoint} from '../types';

const {fontFamily: playfairFamily} = loadPlayfair();
const {fontFamily: notoSansFamily} = loadNotoSansSC();

type Props = {
  data: RouteVideoData;
  amapKey?: string;
  amapSecurityCode?: string;
};

type LabelMode = 'none' | 'endpoints' | 'all';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const safeAsset = (src: string) => staticFile(String(src || '').replace(/\\/g, '/').replace(/^\.\//, ''));
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

const styles: Record<string, React.CSSProperties> = {
  font: {fontFamily: `"${playfairFamily}", "${notoSansFamily}", "Microsoft YaHei", system-ui, sans-serif`, color: 'white'},
};

const pointColor = (point: VideoPoint, fallback: string) => {
  if (point.kind === 'from' || point.role === '起') return colors.green;
  if (point.kind === 'to' || point.role === '终') return colors.red;
  return fallback;
};

const PointMarker: React.FC<{point: VideoPoint; x: number; y: number; color: string; visible: boolean; labelMode: LabelMode; delay?: number}> = ({point, x, y, color, visible, labelMode, delay = 0}) => {
  const frame = useCurrentFrame();
  const pop = spring({frame: Math.max(0, frame - delay), fps: 30, config: {damping: 12, stiffness: 130}});
  const showLabel = labelMode === 'all' || (labelMode === 'endpoints' && (point.kind === 'from' || point.kind === 'to'));
  if (!visible) return null;
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: `translate(-50%, -100%) scale(${0.72 + pop * 0.28})`, transformOrigin: '50% 100%', zIndex: 40}}>
      <div style={{position: 'relative', width: 38, height: 52, filter: 'drop-shadow(0 8px 12px rgba(0,0,0,.45))'}}>
        <svg width="38" height="52" viewBox="0 0 38 52">
          <path d="M19 2C9.6 2 2 9.7 2 19.1c0 13 17 30.9 17 30.9s17-17.9 17-30.9C36 9.7 28.4 2 19 2z" fill={color} stroke="white" strokeWidth="2.5" />
          <circle cx="19" cy="19" r="10" fill="white" opacity=".96" />
          <text x="19" y="23" textAnchor="middle" fontSize="13" fontWeight="900" fill={color} fontFamily={`"${notoSansFamily}", sans-serif`}>{point.role}</text>
        </svg>
      </div>
      {showLabel ? (
        <div
          style={{
            position: 'absolute',
            left: 34,
            top: -4,
            maxWidth: 280,
            padding: '8px 12px',
            borderRadius: 12,
            background: 'rgba(255,255,255,.94)',
            color: '#0f172a',
            fontSize: 25,
            lineHeight: 1.12,
            fontWeight: 900,
            whiteSpace: 'nowrap',
            boxShadow: '0 12px 26px rgba(0,0,0,.25)',
            border: `2px solid ${color}`,
          }}
        >
          {point.name}
        </div>
      ) : null}
    </div>
  );
};

const scenicSlotStyle = (slot: number): React.CSSProperties => {
  const gap = 52;
  const top = 152;
  const bottom = 76;
  const stylesBySlot: React.CSSProperties[] = [
    {right: gap, top},
    {right: gap, bottom},
    {left: gap, top: 390},
  ];
  return stylesBySlot[((slot % stylesBySlot.length) + stylesBySlot.length) % stylesBySlot.length];
};

const ScenicCard: React.FC<{spot: ScenicInfo | null; dayColor: string; progress: number; slot: number}> = ({spot, dayColor, progress, slot}) => {
  if (!spot) return null;
  const images = (spot.images || []).slice(0, 2);
  const enter = interpolate(progress, [0, 0.18, 1], [46, 0, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const opacity = interpolate(progress, [0, 0.16, 1], [0, 1, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const fromLeft = slot === 2;
  const description = cleanText(spot.description || '暂无介绍', 178);
  const title = cleanText(spot.title || spot.name || '景点介绍', 34);
  const imageHeight = description.length > 130 ? 126 : description.length > 90 ? 142 : 162;
  const descFontSize = description.length > 145 ? 22 : description.length > 105 ? 24 : 26;
  return (
    <div
      style={{
        position: 'absolute',
        ...scenicSlotStyle(slot),
        width: 560,
        opacity,
        transform: `translateX(${fromLeft ? -enter : enter}px)`,
        borderRadius: 22,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,.32)',
        background: 'rgba(7,17,31,.94)',
        boxShadow: '0 26px 70px rgba(0,0,0,.46)',
        display: 'flex',
        flexDirection: 'column',
        ...styles.font,
        zIndex: 60,
      }}
    >
      {images.length ? (
        <div style={{display: 'grid', gridTemplateColumns: images.length === 1 ? '1fr' : '1fr 1fr', gap: 0, height: imageHeight, flex: '0 0 auto', background: 'rgba(2,6,14,.82)'}}>
          {images.map((src, index) => (
            <Img key={src + index} src={safeAsset(src)} style={{width: '100%', height: '100%', objectFit: 'contain'}} />
          ))}
        </div>
      ) : null}
      <div style={{padding: '20px 24px 24px', background: 'linear-gradient(145deg, rgba(7,17,31,.98), rgba(15,23,42,.94))', borderTop: images.length ? '1px solid rgba(255,255,255,.16)' : undefined}}>
        <div style={{display: 'grid', gridTemplateColumns: '11px 1fr', alignItems: 'start', gap: 12, marginBottom: 10}}>
          <span style={{width: 11, height: 32, borderRadius: 99, background: dayColor, boxShadow: `0 0 20px ${dayColor}`, marginTop: 2}} />
          <div style={{fontSize: 32, fontWeight: 950, lineHeight: 1.12, wordBreak: 'break-word'}}>{title}</div>
        </div>
        <div style={{fontSize: descFontSize, lineHeight: 1.36, color: 'rgba(255,255,255,.9)', wordBreak: 'break-word'}}>{description}</div>
      </div>
    </div>
  );
};

const Hud: React.FC<{data: RouteVideoData; day: VideoDay; dayIndex: number; progress: number}> = ({data, day, dayIndex, progress}) => {
  const distance = dayDistance(day);
  const duration = dayDurationSeconds(day);
  const metric = formatTripMetric(distance, duration);
  const segmentIndex = Math.min(day.segments.length - 1, Math.floor(progress * Math.max(1, day.segments.length)));
  const segment = day.segments[segmentIndex];
  return (
    <div
      style={{
        position: 'absolute',
        left: 52,
        top: 38,
        width: 930,
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
        zIndex: 75,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 14}}>
        <div style={{fontSize: 52, lineHeight: 0.92, fontWeight: 1000, color: day.color}}>D{dayIndex + 1}</div>
        <div style={{width: 2, height: 50, background: 'rgba(255,255,255,.22)'}} />
      </div>
      <div style={{minWidth: 0}}>
        <div style={{display: 'flex', alignItems: 'baseline', gap: 14, minWidth: 0}}>
          <div style={{fontSize: 28, fontWeight: 950, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 620}}>{stripDayPrefix(day.title)}</div>
          <div style={{fontSize: 25, fontWeight: 950, color: 'rgba(255,255,255,.9)', whiteSpace: 'nowrap'}}>{metric}</div>
        </div>
        <div style={{fontSize: 19, color: 'rgba(255,255,255,.78)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
          {segment ? `${segment.from} -> ${segment.to}` : data.route.name}
        </div>
      </div>
    </div>
  );
};

const Badge: React.FC<{value: string}> = ({value}) => (
  <div style={{minWidth: 170, padding: '15px 18px', borderRadius: 16, background: 'rgba(255,255,255,.11)', border: '1px solid rgba(255,255,255,.18)', textAlign: 'center'}}>
    <div style={{fontSize: 28, fontWeight: 1000}}>{value}</div>
  </div>
);

const CoverBadge: React.FC<{value: string}> = ({value}) => (
  <div style={{minWidth: 230, padding: '18px 22px', borderRadius: 18, background: 'rgba(255,255,255,.13)', border: '1px solid rgba(255,255,255,.22)', textAlign: 'center'}}>
    <div style={{fontSize: 42, fontWeight: 1000}}>{value}</div>
  </div>
);

const RouteLayer: React.FC<{data: RouteVideoData; activeDayIndex: number | null; activeProgress: number; camera: ReturnType<typeof computeCamera>}> = ({data, activeDayIndex, activeProgress, camera}) => {
  return (
    <svg width="1920" height="1080" style={{position: 'absolute', inset: 0, overflow: 'visible', zIndex: 20}}>
      <defs>
        <filter id="routeGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {data.days.map((day, dayIndex) => {
        const path = svgPath(dayPath(day), camera.project);
        const isPast = activeDayIndex !== null && dayIndex < activeDayIndex;
        const isCurrent = activeDayIndex === dayIndex;
        const isFuture = activeDayIndex !== null && dayIndex > activeDayIndex;
        const reveal = activeDayIndex === null ? 1 : isPast ? 1 : isCurrent ? activeProgress : isFuture ? 1 : 1;
        return (
          <g key={dayIndex}>
            <path d={path} fill="none" stroke="rgba(0,0,0,.46)" strokeWidth={isCurrent ? 15 : 10} strokeLinecap="round" strokeLinejoin="round" />
            <path
              d={path}
              fill="none"
              stroke={day.color}
              strokeWidth={isCurrent ? 8 : 5}
              strokeOpacity={isFuture ? 0.24 : isCurrent ? 0.96 : 0.68}
              strokeLinecap="round"
              strokeLinejoin="round"
              filter={isCurrent ? 'url(#routeGlow)' : undefined}
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - reveal}
            />
          </g>
        );
      })}
    </svg>
  );
};

const MarkersLayer: React.FC<{data: RouteVideoData; activeDayIndex: number | null; activeProgress: number; camera: ReturnType<typeof computeCamera>}> = ({data, activeDayIndex, activeProgress, camera}) => {
  return (
    <>
      {data.days.map((day, dayIndex) => {
        const thresholds = cumulativePointProgress(day, camera.project);
        let labelMode: LabelMode = 'none';
        if (activeDayIndex === null) labelMode = 'endpoints';
        else if (dayIndex < activeDayIndex) labelMode = 'endpoints';
        else if (dayIndex === activeDayIndex) labelMode = 'all';
        return day.points.map((point, pointIndex) => {
          const {x, y} = camera.project([point.lng, point.lat]);
          const visible = activeDayIndex === null || dayIndex < activeDayIndex || (dayIndex === activeDayIndex && thresholds[pointIndex] <= activeProgress + 0.015);
          return <PointMarker key={`${dayIndex}-${pointIndex}-${point.name}`} point={point} x={x} y={y} color={pointColor(point, day.color)} visible={visible} labelMode={labelMode} delay={pointIndex * 4} />;
        });
      })}
    </>
  );
};

const Runner: React.FC<{day: VideoDay; progress: number; camera: ReturnType<typeof computeCamera>}> = ({day, progress, camera}) => {
  const coord = samplePath(dayPath(day), progress, camera.project);
  const {x, y} = camera.project(coord);
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: 'translate(-50%, -50%)', zIndex: 55}}>
      <div style={{width: 34, height: 34, borderRadius: 999, background: 'white', border: `9px solid ${day.color}`, boxShadow: `0 0 0 10px rgba(255,255,255,.20), 0 0 34px ${day.color}, 0 12px 25px rgba(0,0,0,.45)`}} />
    </div>
  );
};

const Cover: React.FC<{data: RouteVideoData; frame: number}> = ({data, frame}) => {
  const coverFrames = getCoverFrames(data);
  const opacity = interpolate(frame, [0, Math.min(20, coverFrames * 0.35), Math.max(coverFrames - 28, coverFrames * 0.65), coverFrames], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{opacity, zIndex: 90, background: 'linear-gradient(90deg, rgba(3,7,18,.88), rgba(3,7,18,.42), rgba(3,7,18,.12))', ...styles.font}}>
      <div style={{position: 'absolute', left: 78, top: 166, width: 850}}>
        <div style={{fontSize: 34, color: colors.cyan, fontWeight: 900, letterSpacing: 2}}>路线总览</div>
        <div style={{fontSize: 108, lineHeight: 1.02, fontWeight: 1000, marginTop: 18, textShadow: '0 16px 45px rgba(0,0,0,.45)'}}>{data.route.name}</div>
        <div style={{marginTop: 34, display: 'flex', gap: 18}}>
          <CoverBadge value={`${data.days.length}天`} />
          <CoverBadge value={formatTripMetric(data.summary.totalDistance, data.summary.totalDuration)} />
        </div>
      </div>
      <div style={{position: 'absolute', left: 80, bottom: 70, display: 'grid', gap: 12, width: 760}}>
        {data.days.map((day, i) => (
          <div key={day.title} style={{padding: '14px 20px', borderRadius: 18, background: 'rgba(255,255,255,.13)', border: `1px solid ${day.color}`, fontSize: 31, fontWeight: 900}}>D{i + 1} {cleanText(stripDayPrefix(day.title), 30)}</div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const Outro: React.FC<{data: RouteVideoData; frame: number}> = ({data, frame}) => {
  const total = getTotalDuration(data);
  const outroFrames = getOutroFrames(data);
  const start = total - outroFrames;
  const local = frame - start;
  const opacity = interpolate(local, [0, Math.min(26, outroFrames * 0.45), Math.max(outroFrames - 12, outroFrames * 0.72)], [0, 1, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const scenicHighlights = uniqueHighlights(data).slice(0, 4);
  const highlightCards = scenicHighlights.length
    ? scenicHighlights
    : data.days.slice(0, 4).map((day, index) => ({
        title: day.title,
        description: `${day.points[0]?.name || '起点'} → ${day.points[day.points.length - 1]?.name || '终点'}`,
        images: [],
        name: `day-${index}`,
      }));
  return (
    <AbsoluteFill style={{opacity, zIndex: 95, background: 'linear-gradient(90deg, rgba(2,6,14,.90), rgba(2,6,14,.72), rgba(2,6,14,.86))', ...styles.font}}>
      <div style={{position: 'absolute', left: 70, top: 70, right: 70}}>
        <div style={{fontSize: 34, fontWeight: 950, color: colors.orange, letterSpacing: 2}}>行程汇总</div>
        <div style={{fontSize: 78, fontWeight: 1000, marginTop: 12}}>路线与途经点</div>
        <div style={{display: 'flex', gap: 18, marginTop: 28}}>
          <Badge value={`${data.summary.dayCount}天`} />
          <Badge value={formatTripMetric(data.summary.totalDistance, data.summary.totalDuration)} />
        </div>
      </div>
      <div style={{position: 'absolute', left: 70, right: 70, bottom: 70, display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, highlightCards.length)}, 1fr)`, gap: 20}}>
        {highlightCards.map((spot, index) => (
          <div key={spot.title + index} style={{height: 382, borderRadius: 24, overflow: 'hidden', background: 'rgba(255,255,255,.10)', border: '1px solid rgba(255,255,255,.22)', boxShadow: '0 22px 60px rgba(0,0,0,.36)'}}>
            {spot.images?.[0] ? <Img src={safeAsset(spot.images[0])} style={{width: '100%', height: 156, objectFit: 'contain', background: 'rgba(2,6,14,.7)'}} /> : <div style={{height: 156, background: 'linear-gradient(135deg, #183b63, #0f172a)'}} />}
            <div style={{padding: 22}}>
              <div style={{fontSize: 33, fontWeight: 1000, lineHeight: 1.12}}>{cleanText(spot.title, 24)}</div>
              <div style={{fontSize: 23, lineHeight: 1.34, marginTop: 12, color: 'rgba(255,255,255,.82)'}}>{cleanText(spot.description || '', 90)}</div>
            </div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const uniqueHighlights = (data: RouteVideoData): ScenicInfo[] => {
  const seen = new Set<string>();
  const result: ScenicInfo[] = [];
  data.days.forEach((day) => {
    day.points.forEach((point) => {
      if (!point.scenic) return;
      const key = point.scenic.title || point.scenic.name || point.name;
      if (seen.has(key)) return;
      seen.add(key);
      result.push(point.scenic);
    });
  });
  return result;
};

const activeScenics = (day: VideoDay, progress: number, thresholds: number[]): {spot: ScenicInfo; local: number; slot: number; key: string}[] => {
  const revealed: {spot: ScenicInfo; local: number; key: string}[] = [];
  for (let index = 0; index < day.points.length; index++) {
    const point = day.points[index];
    if (point.kind === 'from' || !point.scenic) continue;
    const t = thresholds[index] ?? 0;
    const isLastPoint = index === day.points.length - 1;
    const revealAt = isLastPoint ? Math.max(0, t - 0.08) : t;
    if (progress < revealAt) continue;
    const local = clamp((progress - revealAt) / 0.08, 0, 1);
    revealed.push({spot: point.scenic, local, key: `${index}-${point.name}`});
  }
  return revealed.slice(0, 3).map((item, slot) => ({spot: item.spot, local: item.local, slot, key: item.key}));
};

export const AmapRouteVideo: React.FC<Props> = ({data, amapKey, amapSecurityCode}) => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  const camera = React.useMemo(() => computeCamera(data, width, height), [data, width, height]);
  const active = findActiveTiming(frame, data);
  const activeDayIndex = active ? active.dayIndex : frame < getCoverFrames(data) ? null : data.days.length;
  const activeDay = active ? data.days[active.dayIndex] : null;
  const local = active ? frame - active.start : 0;
  const revealStart = 0;
  const revealEnd = active ? Math.min(active.duration, DAY_ROUTE_FRAMES) : 1;
  const activeProgress = active ? interpolate(local, [revealStart, revealEnd], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : 1;
  const thresholds = activeDay ? cumulativePointProgress(activeDay, camera.project) : [];
  const scenics = activeDay ? activeScenics(activeDay, activeProgress, thresholds) : [];
  const backdrop = (
    <AMapFixedBackdrop
      center={camera.center}
      zoom={camera.zoom}
      mapLayer={data.mapLayer || 'standard'}
      amapKey={amapKey}
      amapSecurityCode={amapSecurityCode}
      staticMapImage={data.staticMapImage}
    />
  );

  if (data.renderMode === 'mapOnly') {
    return <AbsoluteFill style={{background: '#020713', overflow: 'hidden'}}>{backdrop}</AbsoluteFill>;
  }

  if (data.renderMode === 'overview') {
    return (
      <AbsoluteFill style={{background: '#020713', overflow: 'hidden', ...styles.font}}>
        {backdrop}
        <RouteLayer data={data} activeDayIndex={null} activeProgress={1} camera={camera} />
        <MarkersLayer data={data} activeDayIndex={null} activeProgress={1} camera={camera} />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{background: '#020713', overflow: 'hidden', ...styles.font}}>
      {backdrop}
      <RouteLayer data={data} activeDayIndex={active ? active.dayIndex : null} activeProgress={activeProgress} camera={camera} />
      <MarkersLayer data={data} activeDayIndex={active ? active.dayIndex : null} activeProgress={activeProgress} camera={camera} />
      {activeDay ? <Runner day={activeDay} progress={activeProgress} camera={camera} /> : null}
      {activeDay && active ? <Hud data={data} day={activeDay} dayIndex={active.dayIndex} progress={activeProgress} /> : null}
      {scenics.map((scenic) => (
        <ScenicCard key={scenic.key} spot={scenic.spot} dayColor={activeDay?.color || colors.blue} progress={scenic.local} slot={scenic.slot} />
      ))}
      <Cover data={data} frame={frame} />
      <Outro data={data} frame={frame} />
    </AbsoluteFill>
  );
};




