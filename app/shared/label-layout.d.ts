export type LabelBox = {x: number; y: number; width: number; height: number};

export type LabelLayoutItem = {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  userOffset?: {x: number; y: number};
  avoidRects?: LabelBox[];
  obstacles?: LabelBox[];
  locked?: boolean;
};

export type LabelLayoutOptions = {
  width: number;
  height: number;
  scale?: number;
  baseOffset?: {x: number; y: number};
  gap?: number;
  routeClearance?: number;
  maxRings?: number;
  lockPositions?: boolean;
  items?: LabelLayoutItem[];
  obstacles?: LabelBox[];
  paths?: {x: number; y: number}[][];
};

export type LabelLayoutResult = LabelBox & {shiftX: number; shiftY: number; locked: boolean};

export function layoutLabels(options: LabelLayoutOptions): Map<string, LabelLayoutResult>;
