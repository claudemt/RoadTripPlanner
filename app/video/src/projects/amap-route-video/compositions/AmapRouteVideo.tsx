import React from 'react';
import {AbsoluteFill, Img, continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {AMapFixedBackdrop} from '../components/AMapFixedBackdrop';
import {computeCamera, cumulativePointProgress, dayPath, layoutPointLabels, sampleDayPath, svgPath, LabelBox} from '../lib/geo';
import {cleanText, dayDistance, dayDurationSeconds, findActiveTiming, formatTripMetric, getCoverFrames, getDayRouteFrames, getOutroFrames, getTotalDuration} from '../lib/timeline';
import {RouteVideoData, ScenicInfo, VideoDay, VideoPoint} from '../types';
import weatherCodeMap from '../../../../../shared/weather-codes.json';

const notoSansFamily = 'RoadTrip Noto Sans SC';
if (typeof document !== 'undefined') {
  const fontHandle = delayRender('Loading bundled Noto Sans SC');
  const fontFace = new FontFace(notoSansFamily, `url(${staticFile('fonts/NotoSansSC-Regular.otf')})`);
  fontFace.load()
    .then((loadedFont) => document.fonts.add(loadedFont))
    .catch(() => {})
    .finally(() => continueRender(fontHandle));
}

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

// 顶部信息条（Hud）在 1280x720 下的占位矩形，供标签布局避让，避免途径点标签被黑条遮挡。
const HUD_RECT = {x: 52, y: 38, width: 930, height: 120};

const styles: Record<string, React.CSSProperties> = {
  font: {fontFamily: `"${notoSansFamily}", "Microsoft YaHei", system-ui, sans-serif`, color: 'white'},
};

const pointColor = (point: VideoPoint, fallback: string) => {
  if (point.kind === 'from' || point.role === '起') return colors.green;
  if (point.kind === 'to' || point.role === '终') return colors.red;
  return fallback;
};

const weatherMeta = (code: number) => {
  return (weatherCodeMap as Record<string, {label: string; icon: string}>)[String(code)] || {label: '未知天气', icon: 'cloudy'};
};
const pointFacts = (point: VideoPoint, data: RouteVideoData) => {
  const values: string[] = [];
  if (data.presentation?.weather && point.weather) values.push(`${weatherMeta(point.weather.code).label} · ${Math.round(point.weather.minC)}–${Math.round(point.weather.maxC)} °C`);
  if (data.presentation?.elevation && Number.isFinite(Number(point.elevationM))) values.push(`${Math.round(Number(point.elevationM) / 10) * 10} m`);
  return values.join(' · ');
};

const isSamePoint = (left: VideoPoint | undefined, right: VideoPoint | undefined) => {
  if (!left || !right) return false;
  const leftName = String(left.name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const rightName = String(right.name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return Boolean(leftName && leftName === rightName)
    && Math.abs(Number(left.lng) - Number(right.lng)) <= 0.000001
    && Math.abs(Number(left.lat) - Number(right.lat)) <= 0.000001;
};

const isDuplicateDayStart = (data: RouteVideoData, dayIndex: number, pointIndex: number) =>
  dayIndex > 0
  && pointIndex === 0
  && isSamePoint(
    data.days[dayIndex - 1]?.points[data.days[dayIndex - 1].points.length - 1],
    data.days[dayIndex]?.points[0],
  );

const visualPointsForDay = (data: RouteVideoData, dayIndex: number) =>
  data.days[dayIndex].points.filter((_, pointIndex) => !isDuplicateDayStart(data, dayIndex, pointIndex));

const PointMarker: React.FC<{data: RouteVideoData; point: VideoPoint; x: number; y: number; color: string; visible: boolean; labelMode: LabelMode; labelText?: string; labelBox?: LabelBox; delay?: number}> = ({data, point, x, y, color, visible, labelMode, labelText, labelBox, delay = 0}) => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  const pop = spring({frame: Math.max(0, frame - delay), fps: 30, config: {damping: 12, stiffness: 130}});
  const showLabel = labelMode === 'all' || (labelMode === 'endpoints' && (point.kind === 'from' || point.kind === 'to'));
  const labelOffset = point.labelOffset || {x: 0, y: 0};
  const scale = clamp(Math.min(width / 1280, height / 720), 0.9, 1.35);
  const markerWidth = 38 * scale;
  const markerHeight = 52 * scale;
  if (!visible) return null;
  const facts = pointFacts(point, data);
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: `translate(-50%, -100%) scale(${0.72 + pop * 0.28})`, transformOrigin: '50% 100%', zIndex: 40}}>
      <div style={{position: 'relative', width: markerWidth, height: markerHeight, filter: 'drop-shadow(0 8px 12px rgba(0,0,0,.45))'}}>
        <svg width={markerWidth} height={markerHeight} viewBox="0 0 38 52">
          <path d="M19 2C9.6 2 2 9.7 2 19.1c0 13 17 30.9 17 30.9s17-17.9 17-30.9C36 9.7 28.4 2 19 2z" fill={color} stroke="white" strokeWidth="2.5" />
          <circle cx="19" cy="19" r="10" fill="white" opacity=".96" />
          <text x="19" y="23" textAnchor="middle" fontSize="13" fontWeight="900" fill={color} fontFamily={`"${notoSansFamily}", sans-serif`}>{point.role}</text>
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
            color: '#07111f',
            fontSize: 14 * scale,
            lineHeight: 1.08,
            fontWeight: 900,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            boxShadow: '0 7px 16px rgba(0,0,0,.28)',
            border: `${Math.max(1, scale)}px solid rgba(7,17,31,.88)`,
            textShadow: '0 1px 0 rgba(255,255,255,.9)',
          }}
        >
          <div>{labelText || point.name}</div>
          {facts ? <div style={{display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, color: '#475569', fontSize: 11 * scale}}>{data.presentation?.weather && point.weather ? <Img src={staticFile(`weather/${weatherMeta(point.weather.code).icon}.svg`)} style={{width: 15 * scale, height: 15 * scale}} /> : null}<span>{facts}</span></div> : null}
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
          {segment ? `${segment.from} → ${segment.to} · ${formatTripMetric(segment.distance, segment.duration)}` : data.route.name}
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
  const {width, height} = useVideoConfig();
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{position: 'absolute', inset: 0, overflow: 'visible', zIndex: 20}}>
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
  const {width, height} = useVideoConfig();
  const labelItems = data.days.flatMap((day, dayIndex) => {
    const thresholds = cumulativePointProgress(day, camera.project);
    let labelMode: LabelMode = 'none';
    if (activeDayIndex === null) labelMode = 'all';
    else if (dayIndex < activeDayIndex) labelMode = 'endpoints';
    else if (dayIndex === activeDayIndex) labelMode = 'all';
    return day.points.flatMap((point, pointIndex) => {
      if (isDuplicateDayStart(data, dayIndex, pointIndex)) return [];
      const visible = activeDayIndex === null || dayIndex < activeDayIndex || (dayIndex === activeDayIndex && thresholds[pointIndex] <= activeProgress + 0.015);
      const showLabel = labelMode === 'all' || (labelMode === 'endpoints' && (point.kind === 'from' || point.kind === 'to'));
      if (!visible || !showLabel) return [];
      const {x, y} = camera.project([point.lng, point.lat]);
      const key = `${dayIndex}-${pointIndex}-${point.name}`;
      const facts = pointFacts(point, data);
      return [{key, x, y, text: `D${dayIndex + 1}-${point.role} ${point.name}${facts ? `\n${facts}` : ''}`, labelOffset: point.labelOffset}];
    });
  });
  const labelBoxes = layoutPointLabels(labelItems, width, height, activeDayIndex === null ? [] : [HUD_RECT]);
  return (
    <>
      {data.days.map((day, dayIndex) => {
        const thresholds = cumulativePointProgress(day, camera.project);
        let labelMode: LabelMode = 'none';
        if (activeDayIndex === null) labelMode = 'all';
        else if (dayIndex < activeDayIndex) labelMode = 'endpoints';
        else if (dayIndex === activeDayIndex) labelMode = 'all';
        return day.points.map((point, pointIndex) => {
          if (isDuplicateDayStart(data, dayIndex, pointIndex)) return null;
          const {x, y} = camera.project([point.lng, point.lat]);
          const visible = activeDayIndex === null || dayIndex < activeDayIndex || (dayIndex === activeDayIndex && thresholds[pointIndex] <= activeProgress + 0.015);
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
              labelText={`D${dayIndex + 1}-${point.role} ${point.name}`}
              labelBox={labelBoxes.get(`${dayIndex}-${pointIndex}-${point.name}`)}
              delay={pointIndex * 4}
            />
          );
        });
      })}
    </>
  );
};

type TransportMode = 'drive' | 'ride' | 'walk';

const TransportIcon: React.FC<{mode: TransportMode; color: string}> = ({mode, color}) => {
  if (mode === 'ride') {
    return (
      <svg width="62" height="42" viewBox="0 0 62 42" aria-label="自行车">
        <title>自行车</title>
        <circle cx="14" cy="31" r="9" fill="none" stroke="white" strokeWidth="3" />
        <circle cx="48" cy="31" r="9" fill="none" stroke="white" strokeWidth="3" />
        <path d="M14 31 25 16h12l11 15M25 16l7 15m-7-15h-7m19 0h7m-4-5h7" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="35" cy="7" r="4" fill="white" />
        <path d="m35 12-7 7 8 5 7-9" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (mode === 'walk') {
    return (
      <svg width="48" height="48" viewBox="0 0 48 48" aria-label="步行">
        <title>步行</title>
        <circle cx="28" cy="8" r="5" fill="white" />
        <path d="m25 15-6 11 7 4 3 11m-4-15 8 5 6-7m-13-9 8 4" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="m26 41-6 3m15-4 7 3" stroke={color} strokeWidth="4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="62" height="42" viewBox="0 0 62 42" aria-label="汽车">
      <title>汽车</title>
      <path d="M10 25 15 13c1-3 3-4 6-4h20c3 0 5 1 6 4l5 12v7H10z" fill={color} stroke="white" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="m18 13-3 9h32l-3-9z" fill="#10213a" stroke="white" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="19" cy="32" r="5" fill="#101820" stroke="white" strokeWidth="2" />
      <circle cx="45" cy="32" r="5" fill="#101820" stroke="white" strokeWidth="2" />
      <path d="M13 25h36" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
};

const Runner: React.FC<{day: VideoDay; progress: number; camera: ReturnType<typeof computeCamera>}> = ({day, progress, camera}) => {
  const coord = sampleDayPath(day, progress, camera.project);
  const {x, y} = camera.project(coord);
  const thresholds = cumulativePointProgress(day, camera.project);
  const nextPointIndex = thresholds.findIndex((threshold, index) => index > 0 && progress <= threshold);
  const segmentIndex = nextPointIndex < 0 ? Math.max(0, day.segments.length - 1) : Math.max(0, nextPointIndex - 1);
  const mode: TransportMode = day.segments[segmentIndex]?.mode || day.points[segmentIndex + 1]?.transportMode || 'drive';
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: 'translate(-50%, -50%)', zIndex: 55}}>
      <div style={{display: 'grid', placeItems: 'center', minWidth: 70, minHeight: 54, padding: '4px 7px', borderRadius: 16, background: 'rgba(7,17,31,.88)', border: `2px solid ${day.color}`, boxShadow: `0 0 0 7px rgba(255,255,255,.14), 0 0 34px ${day.color}, 0 12px 25px rgba(0,0,0,.45)`}}>
        <TransportIcon mode={mode} color={day.color} />
      </div>
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
      <div style={{position: 'absolute', left: 70, right: 70, bottom: 64, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 480, overflow: 'hidden'}}>
        {data.days.map((day, dayIndex) => {
          const points = visualPointsForDay(data, dayIndex);
          return <div key={day.title || dayIndex} style={{display: 'flex', alignItems: 'center', gap: 12}}>
            <div style={{flex: '0 0 auto', minWidth: 62, textAlign: 'center', padding: '10px 12px', borderRadius: 14, background: day.color, color: '#07111f', fontWeight: 1000, fontSize: 24}}>D{dayIndex + 1}</div>
            <div style={{display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, flex: 1, minWidth: 0}}>
              {points.map((point, pointIndex) => (
                <React.Fragment key={`${dayIndex}-${pointIndex}-${point.name}`}>
                  {pointIndex > 0 ? <span style={{color: 'rgba(255,255,255,.55)', fontSize: 24, fontWeight: 900, flex: '0 0 auto'}}>→</span> : null}
                  <div style={{padding: '8px 14px', borderRadius: 12, background: 'rgba(255,255,255,.12)', border: `2px solid ${pointColor(point, day.color)}`, fontSize: 22, fontWeight: 900, whiteSpace: 'nowrap'}}>
                    <span style={{opacity: .75, marginRight: 6}}>{point.role}</span>{cleanText(point.name, 16)}
                  </div>
                </React.Fragment>
              ))}
            </div>
          </div>;
        })}
      </div>
    </AbsoluteFill>
  );
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
  const revealEnd = active && activeDay ? Math.min(active.duration, getDayRouteFrames(activeDay)) : 1;
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
      hillshade={data.presentation?.hillshade === true}
      hillshadeEndpoint={data.hillshadeEndpoint}
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
