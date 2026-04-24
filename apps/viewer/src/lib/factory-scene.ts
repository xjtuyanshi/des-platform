import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { LayoutDefinition, WorldSnapshot } from '@des-platform/shared-schema';

type DynamicMeshMaps = {
  cars: Map<string, THREE.Object3D>;
  skids: Map<string, THREE.Object3D>;
  amrs: Map<string, THREE.Object3D>;
};

type BinVisual = {
  shell: THREE.Mesh;
  fill: THREE.Mesh;
  label: THREE.Sprite;
  labelTexture: THREE.CanvasTexture;
  labelContext: CanvasRenderingContext2D;
};

type StationVisual = {
  workZone: THREE.Mesh;
  statusLight: THREE.Mesh;
  controlPedestal: THREE.Mesh;
};

type CameraMode = 'manual' | 'line-follow' | 'station-close';

type MotionTween = {
  fromPosition: THREE.Vector3;
  toPosition: THREE.Vector3;
  fromRotationY: number;
  toRotationY: number;
  startedAtMs: number;
  durationMs: number;
};

const FLOOR_TOP_Y = 0;
const FLOOR_CENTER_FALLBACK_Z = 6;
const MAIN_LINE_ZONE_HALF_WIDTH = 5;
const CAR_BODY_ASSET_URL = '/assets/car-concept.glb';

let carBodyTemplate: THREE.Group | null = null;
let carBodyTemplatePromise: Promise<THREE.Group> | null = null;

function loadCarBodyTemplate(): Promise<THREE.Group> {
  if (carBodyTemplate) {
    return Promise.resolve(carBodyTemplate);
  }

  if (!carBodyTemplatePromise) {
    const loader = new GLTFLoader();
    carBodyTemplatePromise = loader.loadAsync(CAR_BODY_ASSET_URL).then((gltf) => {
      carBodyTemplate = gltf.scene;
      carBodyTemplate.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      return carBodyTemplate;
    });
  }

  return carBodyTemplatePromise;
}

function easeMotion(progress: number): number {
  const t = THREE.MathUtils.clamp(progress, 0, 1);
  return t * t * (3 - 2 * t);
}

function normalizeAngleRadians(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function lerpAngleRadians(from: number, to: number, t: number): number {
  return from + normalizeAngleRadians(to - from) * t;
}

function colorForBin(quantity: number, isActive: boolean, pendingRequest: boolean): number {
  if (quantity <= 0 && pendingRequest) {
    return 0xd39b32;
  }
  if (quantity <= 0) {
    return 0x7a828d;
  }
  if (isActive) {
    return 0x3f8f77;
  }
  return 0xa9b2bc;
}

function setShadowState(object: THREE.Object3D, castShadow: boolean, receiveShadow: boolean): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = castShadow;
      child.receiveShadow = receiveShadow;
    }
  });
}

function applyTextureSettings(texture: THREE.CanvasTexture, repeatX: number, repeatY: number): THREE.CanvasTexture {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function createConcreteTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create concrete texture canvas');
  }

  context.fillStyle = '#bcc2c7';
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < 2400; index += 1) {
    const x = Math.random() * canvas.width;
    const y = Math.random() * canvas.height;
    const radius = Math.random() * 2.1 + 0.35;
    const tone = 150 + Math.floor(Math.random() * 55);
    context.fillStyle = `rgba(${tone}, ${tone}, ${tone}, ${0.12 + Math.random() * 0.1})`;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  context.strokeStyle = 'rgba(84, 92, 102, 0.24)';
  context.lineWidth = 2;
  for (let x = 0; x <= canvas.width; x += 128) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, canvas.height);
    context.stroke();
  }
  for (let y = 0; y <= canvas.height; y += 128) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }

  return applyTextureSettings(new THREE.CanvasTexture(canvas), 8, 4);
}

function createHazardTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create hazard texture canvas');
  }

  context.fillStyle = '#101214';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#f0c540';
  context.lineWidth = 18;
  for (let x = -80; x < canvas.width + 80; x += 36) {
    context.beginPath();
    context.moveTo(x, canvas.height);
    context.lineTo(x + 42, 0);
    context.stroke();
  }

  return applyTextureSettings(new THREE.CanvasTexture(canvas), 1, 1);
}

function createLabelSprite(label: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create label canvas');
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(24, 28, 34, 0.78)';
  context.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(16, 16, canvas.width - 32, canvas.height - 32, 14);
  context.fill();
  context.stroke();
  context.fillStyle = '#eef3f8';
  context.font = '700 34px "IBM Plex Sans", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, canvas.width / 2, canvas.height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    })
  );
  sprite.scale.set(2.35, 0.88, 1);
  return sprite;
}

function createBinValueLabel(): Pick<BinVisual, 'label' | 'labelTexture' | 'labelContext'> {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create bin value canvas');
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    })
  );
  label.scale.set(1.55, 0.58, 1);
  return { label, labelTexture: texture, labelContext: context };
}

function updateBinValueLabel(visual: BinVisual, binId: string, quantity: number, capacity: number): void {
  const { labelContext: context, labelTexture: texture } = visual;
  const canvas = context.canvas;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = quantity <= 0 ? 'rgba(87, 52, 44, 0.88)' : 'rgba(18, 27, 38, 0.82)';
  context.strokeStyle = quantity <= 0 ? 'rgba(255, 144, 114, 0.62)' : 'rgba(255, 255, 255, 0.22)';
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(18, 18, canvas.width - 36, canvas.height - 36, 14);
  context.fill();
  context.stroke();
  context.fillStyle = '#eef3f8';
  context.font = '700 28px "IBM Plex Sans", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const shortId = binId.split('-').at(-1) ?? binId;
  context.fillText(`${shortId} ${quantity}/${capacity}`, canvas.width / 2, canvas.height / 2 + 1);
  texture.needsUpdate = true;
}

function buildBoundsFromPoints(points: Array<THREE.Vector3>, padding = new THREE.Vector3(0, 0, 0)): THREE.Box3 {
  const box = new THREE.Box3().setFromPoints(points);
  box.min.sub(padding);
  box.max.add(padding);
  return box;
}

function computeFloorCenterZ(layout: LayoutDefinition): number {
  if (layout.walls.length === 0) {
    return FLOOR_CENTER_FALLBACK_Z;
  }

  return layout.walls.reduce((sum, wall) => sum + wall.z, 0) / layout.walls.length;
}

function createLaneStrip(
  start: { x: number; z: number },
  end: { x: number; z: number },
  width: number,
  surfaceMaterial: THREE.Material,
  borderMaterial: THREE.Material,
  centerlineMaterial: THREE.Material
): THREE.Group {
  const length = Math.hypot(end.x - start.x, end.z - start.z);
  const angle = Math.atan2(end.z - start.z, end.x - start.x);
  const group = new THREE.Group();
  group.position.set((start.x + end.x) * 0.5, FLOOR_TOP_Y + 0.012, (start.z + end.z) * 0.5);
  group.rotation.x = -Math.PI / 2;
  group.rotation.z = angle;

  const surface = new THREE.Mesh(new THREE.PlaneGeometry(length, width), surfaceMaterial);
  group.add(surface);

  const borderOffset = width / 2 - 0.05;
  const borderLeft = new THREE.Mesh(new THREE.PlaneGeometry(length, 0.08), borderMaterial);
  borderLeft.position.y = borderOffset;
  group.add(borderLeft);

  const borderRight = new THREE.Mesh(new THREE.PlaneGeometry(length, 0.08), borderMaterial);
  borderRight.position.y = -borderOffset;
  group.add(borderRight);

  const centerLine = new THREE.Mesh(new THREE.PlaneGeometry(length * 0.94, 0.05), centerlineMaterial);
  group.add(centerLine);

  return group;
}

export class FactoryScene {
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.PerspectiveCamera(44, 1, 0.1, 300);
  private readonly controls: OrbitControls;
  private readonly dynamic: DynamicMeshMaps = {
    cars: new Map(),
    skids: new Map(),
    amrs: new Map()
  };
  private readonly routeLines = new Map<string, THREE.Group>();
  private readonly binVisuals = new Map<string, BinVisual>();
  private readonly stationVisuals = new Map<string, StationVisual>();
  private readonly motionTweens = new WeakMap<THREE.Object3D, MotionTween>();
  private readonly desiredCameraPosition = new THREE.Vector3();
  private readonly desiredTarget = new THREE.Vector3();
  private readonly animationClock = new THREE.Clock();
  private readonly canvasHost: HTMLElement;
  private readonly floorCenterZ: number;
  private readonly floorBounds: THREE.Box3;
  private readonly lineBounds: THREE.Box3;
  private readonly aisleBounds: THREE.Box3;
  private environmentTarget: THREE.WebGLRenderTarget | null = null;
  private roomEnvironment: RoomEnvironment | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastSnapshot: WorldSnapshot | null = null;
  private cameraMode: CameraMode = 'manual';
  private userControllingCamera = false;

  constructor(private readonly layout: LayoutDefinition, host: HTMLElement) {
    this.canvasHost = host;
    this.floorCenterZ = computeFloorCenterZ(layout);
    this.floorBounds = buildBoundsFromPoints(
      [
        new THREE.Vector3(0, 0, this.floorCenterZ - layout.floor.depth / 2),
        new THREE.Vector3(layout.floor.width, 8, this.floorCenterZ + layout.floor.depth / 2)
      ],
      new THREE.Vector3(1, 0, 1)
    );
    this.lineBounds = buildBoundsFromPoints(
      [
        new THREE.Vector3(layout.line.start.x - 3, 0, -2.2),
        new THREE.Vector3(layout.line.end.x + 3, 5.5, 8.4)
      ],
      new THREE.Vector3(0, 0, 0)
    );
    this.aisleBounds = buildBoundsFromPoints(
      layout.aisleGraph.nodes.map((node) => new THREE.Vector3(node.x, 2, node.z)),
      new THREE.Vector3(3.5, 0, 3.5)
    );

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(host.clientWidth, host.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.76;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.style.cursor = 'grab';

    this.camera.position.set(46, 22, 31);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 130;
    this.controls.minPolarAngle = 0.18;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.zoomSpeed = 1.1;
    this.controls.panSpeed = 0.9;
    this.controls.rotateSpeed = 0.65;
    this.controls.target.set(43, 1.2, 6.5);
    this.controls.enableZoom = true;
    this.controls.enablePan = true;
    this.controls.enableRotate = true;
    if ('zoomToCursor' in this.controls) {
      (this.controls as OrbitControls & { zoomToCursor: boolean }).zoomToCursor = true;
    }
    this.controls.addEventListener('start', () => {
      this.userControllingCamera = true;
      this.cameraMode = 'manual';
      this.renderer.domElement.style.cursor = 'grabbing';
    });
    this.controls.addEventListener('end', () => {
      this.userControllingCamera = false;
      this.desiredCameraPosition.copy(this.camera.position);
      this.desiredTarget.copy(this.controls.target);
      this.renderer.domElement.style.cursor = 'grab';
    });

    this.desiredCameraPosition.copy(this.camera.position);
    this.desiredTarget.copy(this.controls.target);

    this.scene.background = new THREE.Color(0xb8c1c9);
    this.scene.fog = new THREE.Fog(0xb8c1c9, 92, 210);

    host.appendChild(this.renderer.domElement);
    this.buildEnvironment();
    this.attachResize();
    this.fitFactory();
    this.snapCameraToDesired();
    this.renderer.setAnimationLoop(() => this.render());
  }

  setCameraPreset(cameraId: string): void {
    if (cameraId === 'line-follow') {
      this.cameraMode = 'line-follow';
      this.focusLineFollow(this.lastSnapshot);
      return;
    }

    if (cameraId === 'station-close') {
      this.cameraMode = 'station-close';
      this.focusStationClose(this.lastSnapshot);
      return;
    }

    this.cameraMode = 'manual';

    if (cameraId === 'line-overview') {
      this.focusMainLine();
      return;
    }

    if (cameraId === 'overview') {
      this.focusOverview();
      return;
    }

    if (cameraId === 'car-closeup') {
      this.desiredTarget.set(43, 1.1, 0.2);
      this.desiredCameraPosition.set(37.5, 5.4, -7.8);
      return;
    }

    if (cameraId === 'amr-aisle') {
      this.focusAmrAisle();
      return;
    }

    const preset = this.layout.cameras.find((camera) => camera.id === cameraId);
    if (!preset) {
      return;
    }

    this.desiredCameraPosition.set(preset.position.x, preset.position.y, preset.position.z);
    this.desiredTarget.set(preset.target.x, preset.target.y, preset.target.z);
  }

  zoomIn(): void {
    this.cameraMode = 'manual';
    this.zoomBy(0.7);
  }

  zoomOut(): void {
    this.cameraMode = 'manual';
    this.zoomBy(1.38);
  }

  fitFactory(): void {
    this.cameraMode = 'manual';
    this.focusBounds(this.floorBounds, new THREE.Vector3(0.18, 0.4, 1), 0.96);
  }

  private focusOverview(): void {
    this.focusBounds(this.lineBounds, new THREE.Vector3(0.1, 0.18, 1), 0.8);
    this.desiredTarget.y = 1.1;
  }

  focusMainLine(): void {
    this.cameraMode = 'manual';
    this.focusBounds(this.lineBounds, new THREE.Vector3(0.04, 0.16, 1), 0.62);
    this.desiredTarget.y = 1;
  }

  focusAmrAisle(): void {
    this.cameraMode = 'manual';
    this.focusBounds(this.aisleBounds, new THREE.Vector3(-0.62, 0.48, 1), 0.96);
  }

  focusPoint(x: number, z: number): void {
    this.cameraMode = 'manual';
    this.desiredTarget.set(x, 0.7, z);
    this.desiredCameraPosition.set(x - 7.5, 6.8, z + 8.5);
  }

  private focusLineFollow(snapshot: WorldSnapshot | null): void {
    const cars = [...(snapshot?.cars ?? [])].sort((left, right) => left.lineOrder - right.lineOrder);
    const car = cars[Math.floor(cars.length / 2)] ?? null;

    if (!car) {
      const startX = this.layout.line.start.x + this.layout.line.pitchM * 0.5;
      this.desiredTarget.set(startX, 1.05, 0);
      this.desiredCameraPosition.set(startX - 7.4, 5.7, -7.8);
      return;
    }

    this.desiredTarget.set(car.x, 1.08, car.z);
    this.desiredCameraPosition.set(car.x - 7.2, 5.9, car.z - 7.6);
  }

  private focusStationClose(snapshot: WorldSnapshot | null): void {
    const activeStation =
      snapshot?.stations.find((station) => station.currentCarId !== null) ??
      snapshot?.stations[Math.floor((snapshot?.stations.length ?? 1) / 2)] ??
      null;
    const stationLayout =
      this.layout.stations.find((station) => station.id === activeStation?.id) ??
      this.layout.stations[Math.floor(this.layout.stations.length / 2)]!;
    const stationCar = activeStation?.currentCarId
      ? snapshot?.cars.find((car) => car.id === activeStation.currentCarId)
      : null;
    const targetX = stationCar?.x ?? stationLayout.lineX;

    this.desiredTarget.set(targetX, 1.12, 0.65);
    this.desiredCameraPosition.set(targetX - 6.2, 5.35, -6.4);
  }

  applySnapshot(snapshot: WorldSnapshot): void {
    this.lastSnapshot = snapshot;
    this.syncCars(snapshot);
    this.syncSkids(snapshot);
    this.syncAmrs(snapshot);
    this.syncAmrRoutes(snapshot);
    this.syncStations(snapshot);
    this.syncBins(snapshot);

    if (this.cameraMode === 'line-follow') {
      this.focusLineFollow(snapshot);
    }
    if (this.cameraMode === 'station-close') {
      this.focusStationClose(snapshot);
    }
  }

  private getNodePosition(nodeId: string): { x: number; z: number } | null {
    const freeSpaceMatch = /^free:\d+:(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(nodeId);
    if (freeSpaceMatch) {
      return {
        x: Number(freeSpaceMatch[1]),
        z: Number(freeSpaceMatch[2])
      };
    }

    return this.layout.aisleGraph.nodes.find((node) => node.id === nodeId) ?? null;
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    for (const line of this.routeLines.values()) {
      this.scene.remove(line);
      this.disposeObject(line);
    }
    this.routeLines.clear();
    this.renderer.renderLists.dispose();
    this.renderer.forceContextLoss();
    this.renderer.dispose();
    this.environmentTarget?.dispose();
    this.roomEnvironment?.dispose();
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onResize);
    this.canvasHost.removeChild(this.renderer.domElement);
  }

  private zoomBy(multiplier: number): void {
    const offset = this.desiredCameraPosition.clone().sub(this.desiredTarget);
    const distance = THREE.MathUtils.clamp(offset.length() * multiplier, this.controls.minDistance, this.controls.maxDistance);
    offset.setLength(distance);
    this.desiredCameraPosition.copy(this.desiredTarget).add(offset);
  }

  private focusBounds(bounds: THREE.Box3, direction: THREE.Vector3, margin = 1.12): void {
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y * 1.2, size.z) * 0.5;
    const halfVerticalFov = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
    const halfHorizontalFov = Math.atan(Math.tan(halfVerticalFov) * this.camera.aspect);
    const distance = Math.max(radius / Math.tan(halfVerticalFov), radius / Math.tan(halfHorizontalFov)) * margin;

    this.desiredTarget.copy(center);
    this.desiredCameraPosition.copy(center).add(direction.clone().normalize().multiplyScalar(distance));
  }

  private snapCameraToDesired(): void {
    this.camera.position.copy(this.desiredCameraPosition);
    this.controls.target.copy(this.desiredTarget);
    this.controls.update();
  }

  private buildEnvironment(): void {
    this.roomEnvironment = new RoomEnvironment();
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.environmentTarget = pmremGenerator.fromScene(this.roomEnvironment);
    pmremGenerator.dispose();
    this.scene.environment = this.environmentTarget.texture;

    const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x8f98a0, 1.2);
    hemisphereLight.position.set(0, 70, 0);
    this.scene.add(hemisphereLight);

    const sunLight = new THREE.DirectionalLight(0xffffff, 1.15);
    sunLight.position.set(36, 48, 18);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 180;
    sunLight.shadow.camera.left = -60;
    sunLight.shadow.camera.right = 60;
    sunLight.shadow.camera.top = 50;
    sunLight.shadow.camera.bottom = -50;
    sunLight.shadow.bias = -0.00015;
    this.scene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0xeaf0f6, 0.34);
    fillLight.position.set(-28, 20, -26);
    this.scene.add(fillLight);

    this.addFloor();
    this.addMainLine();
    this.addAisleNetwork();
    this.addStations();
    this.addFacilities();
    this.addObstacles();
    this.addWalls();
    this.addOverheadLightRun();
  }

  private addFloor(): void {
    const floorBase = new THREE.Mesh(
      new THREE.BoxGeometry(this.layout.floor.width, this.layout.floor.height, this.layout.floor.depth),
      new THREE.MeshStandardMaterial({
        color: 0xafb6bd,
        metalness: 0,
        roughness: 0.98
      })
    );
    floorBase.position.set(
      this.layout.floor.width / 2,
      -this.layout.floor.height / 2,
      this.floorCenterZ
    );
    floorBase.receiveShadow = true;
    this.scene.add(floorBase);

    const concreteSurface = new THREE.Mesh(
      new THREE.PlaneGeometry(this.layout.floor.width, this.layout.floor.depth),
      new THREE.MeshStandardMaterial({
        map: createConcreteTexture(),
        color: 0xffffff,
        roughness: 0.98
      })
    );
    concreteSurface.rotation.x = -Math.PI / 2;
    concreteSurface.position.set(this.layout.floor.width / 2, FLOOR_TOP_Y + 0.002, this.floorCenterZ);
    concreteSurface.receiveShadow = true;
    this.scene.add(concreteSurface);

    const lineSideZone = new THREE.Mesh(
      new THREE.PlaneGeometry(this.layout.line.end.x - this.layout.line.start.x + 6, 4.4),
      new THREE.MeshStandardMaterial({
        color: 0xd7cba4,
        roughness: 0.95,
        transparent: true,
        opacity: 0.2
      })
    );
    lineSideZone.rotation.x = -Math.PI / 2;
    lineSideZone.position.set(
      (this.layout.line.start.x + this.layout.line.end.x) / 2,
      FLOOR_TOP_Y + 0.006,
      5.2
    );
    this.scene.add(lineSideZone);
  }

  private addMainLine(): void {
    const group = new THREE.Group();
    const lineLength = this.layout.line.end.x - this.layout.line.start.x;

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(lineLength, 0.24, this.layout.line.width),
      new THREE.MeshStandardMaterial({
        color: 0x4f5660,
        metalness: 0.42,
        roughness: 0.58
      })
    );
    base.position.set((this.layout.line.start.x + this.layout.line.end.x) / 2, this.layout.line.elevation, 0);
    base.receiveShadow = true;
    group.add(base);

    const railMaterial = new THREE.MeshStandardMaterial({
      color: 0x8e969f,
      metalness: 0.72,
      roughness: 0.34
    });
    const sideRailGeometry = new THREE.BoxGeometry(lineLength, 0.12, 0.14);
    const railLeft = new THREE.Mesh(sideRailGeometry, railMaterial);
    railLeft.position.set((this.layout.line.start.x + this.layout.line.end.x) / 2, this.layout.line.elevation + 0.17, this.layout.line.width / 2 - 0.18);
    group.add(railLeft);
    const railRight = railLeft.clone();
    railRight.position.z = -(this.layout.line.width / 2 - 0.18);
    group.add(railRight);

    const rollerGeometry = new THREE.CylinderGeometry(0.06, 0.06, this.layout.line.width * 0.72, 12);
    const rollerMaterial = new THREE.MeshStandardMaterial({
      color: 0xaab1ba,
      metalness: 0.78,
      roughness: 0.3
    });
    for (let x = this.layout.line.start.x + 0.6; x < this.layout.line.end.x - 0.6; x += 1.1) {
      const roller = new THREE.Mesh(rollerGeometry, rollerMaterial);
      roller.rotation.x = Math.PI / 2;
      roller.position.set(x, this.layout.line.elevation + 0.16, 0);
      group.add(roller);
    }

    const legGeometry = new THREE.BoxGeometry(0.14, this.layout.line.elevation - 0.08, 0.14);
    const legMaterial = new THREE.MeshStandardMaterial({
      color: 0x666e78,
      metalness: 0.45,
      roughness: 0.62
    });
    for (let x = this.layout.line.start.x + 1; x < this.layout.line.end.x; x += 3.4) {
      for (const z of [-this.layout.line.width / 2 + 0.18, this.layout.line.width / 2 - 0.18]) {
        const leg = new THREE.Mesh(legGeometry, legMaterial);
        leg.position.set(x, (this.layout.line.elevation - 0.08) / 2, z);
        group.add(leg);
      }
    }

    const safetyMarking = new THREE.Mesh(
      new THREE.PlaneGeometry(lineLength + 1.4, 0.14),
      new THREE.MeshStandardMaterial({ color: 0xf3d061, roughness: 0.9 })
    );
    safetyMarking.rotation.x = -Math.PI / 2;
    safetyMarking.position.set((this.layout.line.start.x + this.layout.line.end.x) / 2, FLOOR_TOP_Y + 0.01, MAIN_LINE_ZONE_HALF_WIDTH);
    group.add(safetyMarking);

    const backSafetyMarking = safetyMarking.clone();
    backSafetyMarking.position.z = -2.2;
    group.add(backSafetyMarking);

    setShadowState(group, true, true);
    this.scene.add(group);
  }

  private addAisleNetwork(): void {
    const laneSurfaceMaterial = new THREE.MeshStandardMaterial({
      color: 0xd8dbe0,
      roughness: 0.96,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide
    });
    const laneBorderMaterial = new THREE.MeshStandardMaterial({
      color: 0xf0c85f,
      roughness: 0.82,
      side: THREE.DoubleSide
    });
    const centerLineMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.72,
      transparent: true,
      opacity: 0.76,
      side: THREE.DoubleSide
    });

    const nodeMap = new Map(this.layout.aisleGraph.nodes.map((node) => [node.id, node]));
    for (const [fromId, toId] of this.layout.aisleGraph.edges) {
      const from = nodeMap.get(fromId);
      const to = nodeMap.get(toId);
      if (!from || !to) {
        continue;
      }

      this.scene.add(createLaneStrip(from, to, 1.42, laneSurfaceMaterial, laneBorderMaterial, centerLineMaterial));
    }
  }

  private addStations(): void {
    for (const station of this.layout.stations) {
      const group = new THREE.Group();

      const columnMaterial = new THREE.MeshStandardMaterial({
        color: 0x59606a,
        metalness: 0.48,
        roughness: 0.56
      });
      const beamMaterial = new THREE.MeshStandardMaterial({
        color: 0x708090,
        metalness: 0.54,
        roughness: 0.42
      });

      const leftColumn = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.4, 0.18), columnMaterial);
      leftColumn.position.set(station.lineX - 1.05, 1.7, 1.15);
      group.add(leftColumn);
      const rightColumn = leftColumn.clone();
      rightColumn.position.x = station.lineX + 1.05;
      group.add(rightColumn);

      const beam = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.2, 0.22), beamMaterial);
      beam.position.set(station.lineX, 3.22, 1.15);
      group.add(beam);

      const toolRail = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 0.1), beamMaterial.clone());
      toolRail.position.set(station.lineX, 2.45, 0.42);
      group.add(toolRail);

      const controlPedestal = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 1.2, 0.34),
        new THREE.MeshStandardMaterial({ color: 0x35404b, metalness: 0.35, roughness: 0.64 })
      );
      controlPedestal.position.set(station.lineX - 1.45, 0.6, 1.72);
      group.add(controlPedestal);

      const workZone = new THREE.Mesh(
        new THREE.PlaneGeometry(2.65, 1.45),
        new THREE.MeshStandardMaterial({
          color: 0xebf0f5,
          roughness: 0.88,
          transparent: true,
          opacity: 0.42
        })
      );
      workZone.rotation.x = -Math.PI / 2;
      workZone.position.set(station.lineX, FLOOR_TOP_Y + 0.014, 2.4);
      group.add(workZone);

      const workZoneBorder = new THREE.Mesh(
        new THREE.PlaneGeometry(2.75, 0.08),
        new THREE.MeshStandardMaterial({ color: 0xf0c85f, roughness: 0.9 })
      );
      workZoneBorder.rotation.x = -Math.PI / 2;
      workZoneBorder.position.set(station.lineX, FLOOR_TOP_Y + 0.016, 3.1);
      group.add(workZoneBorder);

      const statusLight = new THREE.Mesh(
        new THREE.BoxGeometry(2.3, 0.12, 0.14),
        new THREE.MeshStandardMaterial({
          color: 0x45b36b,
          emissive: 0x45b36b,
          emissiveIntensity: 0.32,
          roughness: 0.44,
          metalness: 0.05
        })
      );
      statusLight.position.set(station.lineX, 3.48, 1.15);
      group.add(statusLight);

      for (const binSlot of station.binSlots) {
        this.addBinRack(group, binSlot.x, binSlot.z, binSlot.id);
      }

      const label = createLabelSprite(station.id);
      label.position.set(station.lineX, 4.1, 1.3);
      group.add(label);

      this.stationVisuals.set(station.id, {
        workZone,
        statusLight,
        controlPedestal
      });

      setShadowState(group, true, true);
      this.scene.add(group);
    }
  }

  private addBinRack(parent: THREE.Object3D, x: number, z: number, binId: string): void {
    const rack = new THREE.Group();
    const frameMaterial = new THREE.MeshStandardMaterial({
      color: 0x5c6670,
      metalness: 0.58,
      roughness: 0.46
    });
    const shelfMaterial = new THREE.MeshStandardMaterial({
      color: 0xa67933,
      metalness: 0.18,
      roughness: 0.82
    });

    const postGeometry = new THREE.BoxGeometry(0.08, 1.24, 0.08);
    for (const xOffset of [-0.5, 0.5]) {
      for (const zOffset of [-0.42, 0.42]) {
        const post = new THREE.Mesh(postGeometry, frameMaterial);
        post.position.set(x + xOffset, 0.62, z + zOffset);
        rack.add(post);
      }
    }

    const shelf = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.1, 0.92), shelfMaterial);
    shelf.position.set(x, 0.28, z);
    rack.add(shelf);

    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(0.92, 0.68, 0.82),
      new THREE.MeshStandardMaterial({
        color: 0xa5afb8,
        metalness: 0.08,
        roughness: 0.76
      })
    );
    shell.position.set(x, 0.69, z);
    rack.add(shell);

    const fill = new THREE.Mesh(
      new THREE.BoxGeometry(0.76, 0.5, 0.66),
      new THREE.MeshStandardMaterial({
        color: 0x4e8c70,
        metalness: 0.04,
        roughness: 0.62
      })
    );
    fill.position.set(x, 0.51, z);
    rack.add(fill);

    const labelVisual = createBinValueLabel();
    labelVisual.label.position.set(x, 1.42, z + 0.02);
    rack.add(labelVisual.label);

    this.binVisuals.set(binId, { shell, fill, ...labelVisual });
    setShadowState(rack, true, true);
    parent.add(rack);
  }

  private addFacilities(): void {
    this.scene.add(
      this.createRackFacility(
        this.layout.facilities.supermarket.x,
        this.layout.facilities.supermarket.z,
        this.layout.facilities.supermarket.width,
        this.layout.facilities.supermarket.depth,
        0x365665,
        'FULL BIN'
      )
    );
    this.scene.add(
      this.createRackFacility(
        this.layout.facilities.emptyReturn.x,
        this.layout.facilities.emptyReturn.z,
        this.layout.facilities.emptyReturn.width,
        this.layout.facilities.emptyReturn.depth,
        0x6a4f58,
        'EMPTY RETURN'
      )
    );
  }

  private createRackFacility(
    x: number,
    z: number,
    width: number,
    depth: number,
    accentColor: number,
    labelText: string
  ): THREE.Group {
    const group = new THREE.Group();
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.24, depth),
      new THREE.MeshStandardMaterial({ color: 0xbfc7ce, roughness: 0.98 })
    );
    slab.position.set(x, 0.12, z);
    group.add(slab);

    const frameMaterial = new THREE.MeshStandardMaterial({
      color: 0x56616b,
      metalness: 0.56,
      roughness: 0.46
    });
    const accentMaterial = new THREE.MeshStandardMaterial({
      color: accentColor,
      metalness: 0.22,
      roughness: 0.66
    });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(width - 0.4, 1.8, 0.16), frameMaterial);
    frame.position.set(x, 0.96, z - depth * 0.25);
    group.add(frame);
    const upperShelf = new THREE.Mesh(new THREE.BoxGeometry(width - 0.65, 0.1, depth - 0.75), frameMaterial);
    upperShelf.position.set(x, 1.3, z);
    group.add(upperShelf);
    const lowerShelf = upperShelf.clone();
    lowerShelf.position.y = 0.68;
    group.add(lowerShelf);

    for (let shelfIndex = 0; shelfIndex < 2; shelfIndex += 1) {
      for (let columnIndex = -1; columnIndex <= 1; columnIndex += 1) {
        const bin = new THREE.Mesh(new THREE.BoxGeometry(0.88, 0.54, 0.72), accentMaterial);
        bin.position.set(x + columnIndex * 1.1, 0.52 + shelfIndex * 0.64, z + 0.1);
        group.add(bin);
      }
    }

    const label = createLabelSprite(labelText);
    label.position.set(x, 2.35, z);
    group.add(label);

    setShadowState(group, true, true);
    return group;
  }

  private addObstacles(): void {
    const hazardTexture = createHazardTexture();
    for (const obstacle of this.layout.obstacles) {
      const group = new THREE.Group();
      const island = new THREE.Mesh(
        new THREE.BoxGeometry(obstacle.width, obstacle.height, obstacle.depth),
        new THREE.MeshStandardMaterial({
          color: 0x49515a,
          metalness: 0.2,
          roughness: 0.78
        })
      );
      island.position.set(obstacle.x, obstacle.height / 2, obstacle.z);
      group.add(island);

      const hazardTop = new THREE.Mesh(
        new THREE.PlaneGeometry(obstacle.width, obstacle.depth),
        new THREE.MeshStandardMaterial({
          map: hazardTexture,
          roughness: 0.92,
          side: THREE.DoubleSide
        })
      );
      hazardTop.rotation.x = -Math.PI / 2;
      hazardTop.position.set(obstacle.x, obstacle.height + 0.01, obstacle.z);
      group.add(hazardTop);

      for (const xOffset of [-obstacle.width / 2 + 0.22, obstacle.width / 2 - 0.22]) {
        for (const zOffset of [-obstacle.depth / 2 + 0.22, obstacle.depth / 2 - 0.22]) {
          const bollard = new THREE.Mesh(
            new THREE.CylinderGeometry(0.07, 0.07, 0.85, 12),
            new THREE.MeshStandardMaterial({
              color: 0xe5963c,
              metalness: 0.18,
              roughness: 0.62
            })
          );
          bollard.position.set(obstacle.x + xOffset, 0.42, obstacle.z + zOffset);
          group.add(bollard);
        }
      }

      setShadowState(group, true, true);
      this.scene.add(group);
    }
  }

  private addWalls(): void {
    for (const wall of this.layout.walls) {
      const group = new THREE.Group();
      const wallBody = new THREE.Mesh(
        new THREE.BoxGeometry(wall.width, wall.height, wall.depth),
        new THREE.MeshStandardMaterial({
          color: 0xf0f3f6,
          metalness: 0.06,
          roughness: 0.88,
          transparent: true,
          opacity: 0.72
        })
      );
      wallBody.position.set(wall.x, wall.height / 2, wall.z);
      group.add(wallBody);

      for (let x = wall.x - wall.width / 2; x <= wall.x + wall.width / 2; x += 4) {
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(0.1, wall.height + 0.2, wall.depth + 0.06),
          new THREE.MeshStandardMaterial({
            color: 0x7b838b,
            metalness: 0.42,
            roughness: 0.58
          })
        );
        post.position.set(x, wall.height / 2, wall.z);
        group.add(post);
      }

      setShadowState(group, true, true);
      this.scene.add(group);
    }
  }

  private addOverheadLightRun(): void {
    const lightStripMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xf9fbff,
      emissiveIntensity: 0.65,
      roughness: 0.24,
      metalness: 0.02
    });

    for (let x = 16; x <= 72; x += 9.5) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.08, 0.9), lightStripMaterial);
      strip.position.set(x, 8.2, 6);
      this.scene.add(strip);
    }
  }

  private syncCars(snapshot: WorldSnapshot): void {
    const activeIds = new Set(snapshot.cars.map((car) => car.id));
    this.syncDynamicMeshes(
      snapshot.cars,
      this.dynamic.cars,
      activeIds,
      (car) => this.createCarMesh(car.lengthM, car.heightM, car.widthM),
      (object, car, created) => {
        this.setMotionTarget(object, new THREE.Vector3(car.x, car.y - 0.08, car.z), object.rotation.y, created);
      }
    );
  }

  private syncSkids(snapshot: WorldSnapshot): void {
    const activeIds = new Set(snapshot.skids.map((skid) => skid.id));
    this.syncDynamicMeshes(
      snapshot.skids,
      this.dynamic.skids,
      activeIds,
      (skid) => this.createSkidMesh(skid.lengthM, skid.heightM, skid.widthM),
      (object, skid, created) => {
        this.setMotionTarget(object, new THREE.Vector3(skid.x, skid.y - 0.02, skid.z), object.rotation.y, created);
      }
    );
  }

  private syncAmrs(snapshot: WorldSnapshot): void {
    const activeIds = new Set(snapshot.amrs.map((amr) => amr.id));
    this.syncDynamicMeshes(
      snapshot.amrs,
      this.dynamic.amrs,
      activeIds,
      () => this.createAmrMesh(),
      (object, amr, created) => {
        this.setMotionTarget(object, new THREE.Vector3(amr.x, amr.y, amr.z), -amr.yawRad, created);
      }
    );
  }

  private syncAmrRoutes(snapshot: WorldSnapshot): void {
    const activeRouteIds = new Set(
      snapshot.amrs.filter((amr) => amr.routeNodeIds.length > 0).map((amr) => amr.id)
    );

    for (const [amrId, routeGroup] of this.routeLines) {
      if (!activeRouteIds.has(amrId)) {
        this.scene.remove(routeGroup);
        this.disposeObject(routeGroup);
        this.routeLines.delete(amrId);
      }
    }

    for (const amr of snapshot.amrs) {
      if (amr.routeNodeIds.length === 0) {
        continue;
      }

      const color = amr.id.endsWith('1') ? 0x27d6ff : amr.id.endsWith('2') ? 0xffc95c : 0x63d36f;
      const points = [
        new THREE.Vector3(amr.x, FLOOR_TOP_Y + 0.14, amr.z),
        ...amr.routeNodeIds
          .map((nodeId) => this.getNodePosition(nodeId))
          .filter((node): node is { x: number; z: number } => Boolean(node))
          .map((node) => new THREE.Vector3(node.x, FLOOR_TOP_Y + 0.14, node.z))
      ];

      const previousRoute = this.routeLines.get(amr.id);
      if (previousRoute) {
        this.scene.remove(previousRoute);
        this.disposeObject(previousRoute);
      }

      const routeGroup = new THREE.Group();
      routeGroup.name = `${amr.id}-route`;
      for (let index = 1; index < points.length; index += 1) {
        const segment = this.createRouteSegment(points[index - 1]!, points[index]!, color);
        if (segment) {
          routeGroup.add(segment);
        }
      }

      const destination = points.at(-1);
      if (destination) {
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(0.2, 18, 12),
          new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: 0.45,
            roughness: 0.4,
            metalness: 0.08
          })
        );
        marker.position.copy(destination);
        marker.position.y = FLOOR_TOP_Y + 0.28;
        routeGroup.add(marker);
      }

      this.routeLines.set(amr.id, routeGroup);
      this.scene.add(routeGroup);
    }
  }

  private syncStations(snapshot: WorldSnapshot): void {
    for (const station of snapshot.stations) {
      const visual = this.stationVisuals.get(station.id);
      if (!visual) {
        continue;
      }

      const stateColor = new THREE.Color(station.stateColor);
      const workZoneMaterial = visual.workZone.material as THREE.MeshStandardMaterial;
      workZoneMaterial.color.copy(stateColor);
      workZoneMaterial.opacity = station.state === 'running' ? 0.28 : 0.42;

      const statusMaterial = visual.statusLight.material as THREE.MeshStandardMaterial;
      statusMaterial.color.copy(stateColor);
      statusMaterial.emissive.copy(stateColor);
      statusMaterial.emissiveIntensity = station.state === 'idle' ? 0.12 : 0.42;

      const pedestalMaterial = visual.controlPedestal.material as THREE.MeshStandardMaterial;
      pedestalMaterial.color.copy(stateColor).lerp(new THREE.Color(0x202833), 0.48);
    }
  }

  private createRouteSegment(start: THREE.Vector3, end: THREE.Vector3, color: number): THREE.Mesh | null {
    const direction = end.clone().sub(start);
    const length = direction.length();
    if (length < 0.05) {
      return null;
    }

    const segment = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, length, 10),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.28,
        roughness: 0.5,
        metalness: 0.1
      })
    );
    segment.position.copy(start).add(end).multiplyScalar(0.5);
    segment.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    segment.castShadow = false;
    segment.receiveShadow = false;
    return segment;
  }

  private syncBins(snapshot: WorldSnapshot): void {
    for (const station of snapshot.stations) {
      for (const bin of station.bins) {
        const visual = this.binVisuals.get(bin.id);
        if (!visual) {
          continue;
        }

        const shellMaterial = visual.shell.material as THREE.MeshStandardMaterial;
        shellMaterial.color.setHex(colorForBin(bin.quantity, bin.isActive, bin.pendingRequest));

        const fillRatio = bin.capacity > 0 ? bin.quantity / bin.capacity : 0;
        visual.fill.visible = fillRatio > 0.001;
        visual.fill.scale.y = Math.max(fillRatio, 0.04);
        visual.fill.position.y = 0.41 + (0.5 * visual.fill.scale.y) / 2;

        const fillMaterial = visual.fill.material as THREE.MeshStandardMaterial;
        fillMaterial.color.setHex(bin.isActive ? 0x4d9377 : 0x6f8597);
        updateBinValueLabel(visual, bin.id, bin.quantity, bin.capacity);
      }
    }
  }

  private createCarMesh(lengthM: number, heightM: number, widthM: number): THREE.Group {
    const group = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({
      color: 0xe2e7ea,
      metalness: 0.32,
      roughness: 0.28
    });
    const trim = new THREE.MeshStandardMaterial({
      color: 0x2f6f95,
      metalness: 0.28,
      roughness: 0.42
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x2d3947,
      metalness: 0.08,
      roughness: 0.18,
      transparent: true,
      opacity: 0.82
    });
    const tire = new THREE.MeshStandardMaterial({
      color: 0x191b1f,
      roughness: 0.92
    });
    const hub = new THREE.MeshStandardMaterial({
      color: 0x9aa3aa,
      metalness: 0.72,
      roughness: 0.32
    });
    const blackTrim = new THREE.MeshStandardMaterial({
      color: 0x15191e,
      metalness: 0.18,
      roughness: 0.64
    });
    const lamp = new THREE.MeshStandardMaterial({
      color: 0xf4d36a,
      emissive: 0xf4b850,
      emissiveIntensity: 0.18,
      roughness: 0.36
    });
    const tailLamp = new THREE.MeshStandardMaterial({
      color: 0xb7423d,
      emissive: 0x8a211c,
      emissiveIntensity: 0.2,
      roughness: 0.42
    });

    const createProfileGeometry = (points: Array<[number, number]>, depth: number): THREE.ExtrudeGeometry => {
      const shape = new THREE.Shape();
      const [firstX, firstY] = points[0]!;
      shape.moveTo(firstX, firstY);
      for (const [x, y] of points.slice(1)) {
        shape.lineTo(x, y);
      }
      shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelSize: 0.035,
        bevelThickness: 0.035,
        bevelSegments: 2
      });
      geometry.translate(0, 0, -depth / 2);
      return geometry;
    };

    const bodyProfile: Array<[number, number]> = [
      [-lengthM / 2 + 0.14, 0.16],
      [-lengthM / 2 + 0.24, 0.42],
      [-lengthM / 2 + 0.92, 0.58],
      [-lengthM / 2 + 1.52, 0.7],
      [lengthM / 2 - 1.36, 0.7],
      [lengthM / 2 - 0.58, 0.56],
      [lengthM / 2 - 0.13, 0.34],
      [lengthM / 2 - 0.18, 0.17]
    ];
    const cabinProfile: Array<[number, number]> = [
      [-lengthM / 2 + 1.48, 0.7],
      [-lengthM / 2 + 1.86, heightM * 0.86],
      [lengthM / 2 - 1.28, heightM * 0.86],
      [lengthM / 2 - 0.94, 0.7]
    ];
    const body = new THREE.Mesh(createProfileGeometry(bodyProfile, widthM * 0.94), paint);
    group.add(body);

    const cabin = new THREE.Mesh(createProfileGeometry(cabinProfile, widthM * 0.74), paint.clone());
    group.add(cabin);

    const hoodCrease = new THREE.Mesh(new THREE.BoxGeometry(lengthM * 0.2, 0.025, 0.035), trim);
    hoodCrease.position.set(lengthM * 0.26, 0.72, widthM * 0.43);
    group.add(hoodCrease);
    const hoodCreaseRight = hoodCrease.clone();
    hoodCreaseRight.position.z = -widthM * 0.43;
    group.add(hoodCreaseRight);

    const sideWindowShape = new THREE.Shape();
    sideWindowShape.moveTo(-lengthM / 2 + 1.72, 0.76);
    sideWindowShape.lineTo(-lengthM / 2 + 2.0, heightM * 0.78);
    sideWindowShape.lineTo(lengthM / 2 - 1.42, heightM * 0.78);
    sideWindowShape.lineTo(lengthM / 2 - 1.08, 0.76);
    sideWindowShape.closePath();
    const sideWindowGeometry = new THREE.ShapeGeometry(sideWindowShape);
    for (const zOffset of [-widthM * 0.385, widthM * 0.385]) {
      const sideWindow = new THREE.Mesh(sideWindowGeometry, glass);
      sideWindow.position.z = zOffset;
      group.add(sideWindow);
    }

    const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.08, heightM * 0.3, widthM * 0.68), glass);
    windshield.position.set(lengthM / 2 - 1.0, heightM * 0.78, 0);
    windshield.rotation.z = -0.34;
    group.add(windshield);

    const rearGlass = new THREE.Mesh(new THREE.BoxGeometry(0.08, heightM * 0.27, widthM * 0.64), glass.clone());
    rearGlass.position.set(-lengthM / 2 + 1.46, heightM * 0.78, 0);
    rearGlass.rotation.z = 0.38;
    group.add(rearGlass);

    const bumperGeometry = new THREE.BoxGeometry(0.12, 0.18, widthM * 0.88);
    const frontBumper = new THREE.Mesh(bumperGeometry, blackTrim);
    frontBumper.position.set(lengthM / 2 - 0.08, 0.28, 0);
    group.add(frontBumper);
    const rearBumper = frontBumper.clone();
    rearBumper.position.x = -lengthM / 2 + 0.08;
    group.add(rearBumper);

    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.18, widthM * 0.36), blackTrim.clone());
    grille.position.set(lengthM / 2 - 0.02, 0.43, 0);
    group.add(grille);
    for (const zOffset of [-widthM * 0.3, widthM * 0.3]) {
      const headLamp = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.28), lamp);
      headLamp.position.set(lengthM / 2 - 0.015, 0.47, zOffset);
      group.add(headLamp);

      const rearLamp = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.18, 0.22), tailLamp);
      rearLamp.position.set(-lengthM / 2 + 0.015, 0.42, zOffset);
      group.add(rearLamp);
    }

    const doorLine = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.5, 0.02), blackTrim.clone());
    doorLine.position.set(-0.06, 0.55, widthM * 0.475);
    group.add(doorLine);
    const doorLineRight = doorLine.clone();
    doorLineRight.position.z = -widthM * 0.475;
    group.add(doorLineRight);
    for (const zOffset of [-widthM * 0.52, widthM * 0.52]) {
      const rocker = new THREE.Mesh(new THREE.BoxGeometry(lengthM * 0.78, 0.07, 0.055), trim);
      rocker.position.set(-0.06, 0.26, zOffset);
      group.add(rocker);
    }

    const wheelGeometry = new THREE.CylinderGeometry(0.22, 0.22, 0.14, 18);
    const wheelArchGeometry = new THREE.TorusGeometry(0.29, 0.035, 8, 26);
    for (const xOffset of [-lengthM * 0.31, lengthM * 0.31]) {
      for (const zOffset of [-widthM * 0.44, widthM * 0.44]) {
        const wheel = new THREE.Mesh(wheelGeometry, tire);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(xOffset, 0.22, zOffset);
        group.add(wheel);

        const hubCap = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.155, 16), hub);
        hubCap.rotation.x = Math.PI / 2;
        hubCap.position.set(xOffset, 0.22, zOffset + Math.sign(zOffset) * 0.012);
        group.add(hubCap);

        const wheelArch = new THREE.Mesh(wheelArchGeometry, blackTrim);
        wheelArch.position.set(xOffset, 0.28, zOffset + Math.sign(zOffset) * 0.035);
        group.add(wheelArch);
      }
    }

    const frontArrow = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.24, 16), trim.clone());
    frontArrow.rotation.z = -Math.PI / 2;
    frontArrow.position.set(lengthM / 2 - 0.36, 0.86, 0);
    group.add(frontArrow);

    this.hydrateCarBodyAsset(group, lengthM, heightM, widthM);
    setShadowState(group, true, true);
    this.scene.add(group);
    return group;
  }

  private hydrateCarBodyAsset(group: THREE.Group, lengthM: number, heightM: number, widthM: number): void {
    void loadCarBodyTemplate()
      .then((template) => {
        if (!group.parent) {
          return;
        }

        for (const child of [...group.children]) {
          group.remove(child);
          this.disposeObject(child);
        }

        const asset = template.clone(true);
        asset.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry = child.geometry.clone();
            child.material = Array.isArray(child.material)
              ? child.material.map((material) => material.clone())
              : child.material.clone();
          }
        });
        this.fitCarAssetToEnvelope(asset, lengthM, heightM, widthM);
        group.add(asset);
        setShadowState(group, true, true);
      })
      .catch(() => {
        // Keep the procedural fallback when the optional GLB asset cannot be loaded.
      });
  }

  private fitCarAssetToEnvelope(asset: THREE.Group, lengthM: number, heightM: number, widthM: number): void {
    asset.updateMatrixWorld(true);
    let bounds = new THREE.Box3().setFromObject(asset);
    let size = bounds.getSize(new THREE.Vector3());

    if (size.z > size.x) {
      asset.rotation.y += Math.PI / 2;
      asset.updateMatrixWorld(true);
      bounds = new THREE.Box3().setFromObject(asset);
      size = bounds.getSize(new THREE.Vector3());
    }

    const scaleX = lengthM / Math.max(size.x, 0.001);
    const scaleY = (heightM * 0.92) / Math.max(size.y, 0.001);
    const scaleZ = widthM / Math.max(size.z, 0.001);
    asset.scale.multiply(new THREE.Vector3(scaleX, scaleY, scaleZ));
    asset.updateMatrixWorld(true);

    const fittedBounds = new THREE.Box3().setFromObject(asset);
    const center = fittedBounds.getCenter(new THREE.Vector3());
    asset.position.sub(new THREE.Vector3(center.x, fittedBounds.min.y - 0.04, center.z));
    asset.updateMatrixWorld(true);
  }

  private createSkidMesh(lengthM: number, heightM: number, widthM: number): THREE.Group {
    const group = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({
      color: 0x77818c,
      metalness: 0.78,
      roughness: 0.34
    });
    const locatorMaterial = new THREE.MeshStandardMaterial({
      color: 0xd7962d,
      metalness: 0.24,
      roughness: 0.58
    });

    const railGeometry = new THREE.BoxGeometry(lengthM, heightM * 0.36, 0.12);
    const leftRail = new THREE.Mesh(railGeometry, metal);
    leftRail.position.set(0, heightM * 0.16, widthM * 0.42);
    group.add(leftRail);
    const rightRail = leftRail.clone();
    rightRail.position.z = -widthM * 0.42;
    group.add(rightRail);

    for (let x = -lengthM / 2 + 0.45; x <= lengthM / 2 - 0.45; x += 0.8) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(0.12, heightM * 0.3, widthM * 0.78), metal);
      slat.position.set(x, heightM * 0.15, 0);
      group.add(slat);
    }

    for (const xOffset of [-lengthM * 0.36, lengthM * 0.36]) {
      for (const zOffset of [-widthM * 0.28, widthM * 0.28]) {
        const locator = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, heightM * 0.62, 14), locatorMaterial);
        locator.position.set(xOffset, heightM * 0.46, zOffset);
        group.add(locator);
      }
    }

    setShadowState(group, true, true);
    this.scene.add(group);
    return group;
  }

  private createAmrMesh(): THREE.Group {
    const group = new THREE.Group();
    const shellMaterial = new THREE.MeshStandardMaterial({
      color: 0x314a58,
      metalness: 0.42,
      roughness: 0.46
    });
    const accentMaterial = new THREE.MeshStandardMaterial({
      color: 0x4f839c,
      metalness: 0.22,
      roughness: 0.5
    });
    const wheelMaterial = new THREE.MeshStandardMaterial({
      color: 0x191c20,
      roughness: 0.94
    });

    const base = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.28, 1.48), shellMaterial);
    base.position.y = 0.06;
    group.add(base);

    const topDeck = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.12, 1.18), accentMaterial);
    topDeck.position.y = 0.26;
    group.add(topDeck);

    const lidarMast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.24, 12), shellMaterial.clone());
    lidarMast.position.set(0.38, 0.3, -0.38);
    group.add(lidarMast);

    const lidarHead = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 16), accentMaterial.clone());
    lidarHead.position.set(0.38, 0.44, -0.38);
    group.add(lidarHead);

    const wheelGeometry = new THREE.CylinderGeometry(0.12, 0.12, 0.08, 14);
    for (const xOffset of [-0.54, 0.54]) {
      for (const zOffset of [-0.54, 0.54]) {
        const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(xOffset, 0.06, zOffset);
        group.add(wheel);
      }
    }

    setShadowState(group, true, true);
    this.scene.add(group);
    return group;
  }

  private syncDynamicMeshes<T extends { id: string }>(
    items: T[],
    objectMap: Map<string, THREE.Object3D>,
    activeIds: Set<string>,
    createObject: (item: T) => THREE.Object3D,
    updateObject: (object: THREE.Object3D, item: T, created: boolean) => void
  ): void {
    for (const [id, object] of objectMap) {
      if (!activeIds.has(id)) {
        this.scene.remove(object);
        this.disposeObject(object);
        objectMap.delete(id);
      }
    }

    for (const item of items) {
      let object = objectMap.get(item.id);
      let created = false;
      if (!object) {
        object = createObject(item);
        objectMap.set(item.id, object);
        created = true;
      }
      updateObject(object, item, created);
    }
  }

  private setMotionTarget(
    object: THREE.Object3D,
    targetPosition: THREE.Vector3,
    targetRotationY: number,
    immediate = false
  ): void {
    if (immediate) {
      object.position.copy(targetPosition);
      object.rotation.y = targetRotationY;
      object.userData.lastMotionUpdateMs = performance.now();
      return;
    }

    const now = performance.now();
    const previousUpdateMs = typeof object.userData.lastMotionUpdateMs === 'number' ? object.userData.lastMotionUpdateMs : now;
    const updateIntervalMs = Math.max(1, now - previousUpdateMs);
    object.userData.lastMotionUpdateMs = now;

    this.motionTweens.set(object, {
      fromPosition: object.position.clone(),
      toPosition: targetPosition.clone(),
      fromRotationY: object.rotation.y,
      toRotationY: targetRotationY,
      startedAtMs: now,
      durationMs: THREE.MathUtils.clamp(updateIntervalMs * 0.88, 70, 360)
    });
  }

  private applyMotionTweens(nowMs: number): void {
    const objects = [
      ...this.dynamic.cars.values(),
      ...this.dynamic.skids.values(),
      ...this.dynamic.amrs.values()
    ];

    for (const object of objects) {
      const tween = this.motionTweens.get(object);
      if (!tween) {
        continue;
      }

      const progress = (nowMs - tween.startedAtMs) / tween.durationMs;
      const eased = easeMotion(progress);
      object.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
      object.rotation.y = lerpAngleRadians(tween.fromRotationY, tween.toRotationY, eased);

      if (progress >= 1) {
        object.position.copy(tween.toPosition);
        object.rotation.y = tween.toRotationY;
        this.motionTweens.delete(object);
      }
    }
  }

  private disposeObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          material.dispose();
        }
      }

      if (child instanceof THREE.Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    });
  }

  private attachResize(): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.onResize();
    });
    this.resizeObserver.observe(this.canvasHost);
    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  private readonly onResize = () => {
    const width = this.canvasHost.clientWidth;
    const height = this.canvasHost.clientHeight;
    if (width < 2 || height < 2) {
      return;
    }
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private render(): void {
    const delta = Math.min(this.animationClock.getDelta(), 0.05);
    this.applyMotionTweens(performance.now());
    if (this.userControllingCamera) {
      this.desiredCameraPosition.copy(this.camera.position);
      this.desiredTarget.copy(this.controls.target);
    } else {
      this.camera.position.lerp(this.desiredCameraPosition, 1 - Math.exp(-4.5 * delta));
      this.controls.target.lerp(this.desiredTarget, 1 - Math.exp(-4.8 * delta));
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
