import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import type { LayoutDefinition, WorldSnapshot } from '@des-platform/shared-schema';

import { FactoryScene } from '../lib/factory-scene.js';

type FactoryCanvasProps = {
  layout: LayoutDefinition | null;
  snapshot: WorldSnapshot | null;
  cameraId: string;
};

export type FactoryCanvasHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  fitFactory: () => void;
  focusLine: () => void;
  focusAisle: () => void;
  focusPoint: (x: number, z: number) => void;
};

export const FactoryCanvas = forwardRef<FactoryCanvasHandle, FactoryCanvasProps>(function FactoryCanvas(
  { layout, snapshot, cameraId },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<FactoryScene | null>(null);
  const layoutIdRef = useRef<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => sceneRef.current?.zoomIn(),
      zoomOut: () => sceneRef.current?.zoomOut(),
      fitFactory: () => sceneRef.current?.fitFactory(),
      focusLine: () => sceneRef.current?.focusMainLine(),
      focusAisle: () => sceneRef.current?.focusAmrAisle(),
      focusPoint: (x, z) => sceneRef.current?.focusPoint(x, z)
    }),
    []
  );

  useEffect(() => {
    if (!layout || !hostRef.current) {
      return;
    }

    if (sceneRef.current && layoutIdRef.current === layout.id) {
      return;
    }

    const scene = new FactoryScene(layout, hostRef.current);
    sceneRef.current = scene;
    layoutIdRef.current = layout.id;
    scene.setCameraPreset(cameraId);
    return () => {
      scene.dispose();
      if (sceneRef.current === scene) {
        sceneRef.current = null;
        layoutIdRef.current = null;
      }
    };
  }, [layout?.id]);

  useEffect(() => {
    sceneRef.current?.setCameraPreset(cameraId);
  }, [cameraId]);

  useEffect(() => {
    if (snapshot) {
      sceneRef.current?.applySnapshot(snapshot);
    }
  }, [snapshot]);

  return <div className="canvas-host" ref={hostRef} />;
});
