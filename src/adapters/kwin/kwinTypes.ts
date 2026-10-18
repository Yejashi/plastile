// Structural types for the KWin 6.7 declarative-script surface Plastile uses.
// Every member listed here was verified at runtime (docs/status/API_PROFILE.md, or
// the nested measurement named next to it); nothing is assumed from C++ headers alone.

export interface KSignal<A extends unknown[] = unknown[]> {
  connect(fn: (...args: A) => void): void;
  disconnect(fn: (...args: A) => void): void;
}

export interface KRect { x: number; y: number; width: number; height: number }
export interface KSize { width: number; height: number }

export interface KOutput {
  readonly name: string;
  readonly geometry: KRect;
  readonly devicePixelRatio: number;
  readonly manufacturer: string;
  readonly model: string;
  readonly serialNumber: string;
  readonly geometryChanged: KSignal;
}

export interface KDesktop {
  readonly id: string;
  readonly name: string;
  readonly x11DesktopNumber: number;
  /** VirtualDesktop NOTIFY for `name` (a rename emits only this; desktopsChanged does not). */
  readonly nameChanged: KSignal;
}

export interface KTile {
  unmanage(w: KWindow): boolean;
}

export interface KWindow {
  readonly internalId: { toString(): string };
  readonly caption: string;
  readonly resourceClass: string;
  readonly resourceName: string;
  readonly windowRole: string;
  readonly desktopFileName: string;
  readonly pid: number;
  readonly normalWindow: boolean;
  readonly dialog: boolean;
  readonly utility: boolean;
  readonly toolbar: boolean;
  readonly menu: boolean;
  readonly dropdownMenu: boolean;
  readonly popupMenu: boolean;
  readonly comboBox: boolean;
  readonly splash: boolean;
  readonly dock: boolean;
  readonly desktopWindow: boolean;
  readonly notification: boolean;
  readonly criticalNotification: boolean;
  readonly tooltip: boolean;
  readonly onScreenDisplay: boolean;
  readonly appletPopup: boolean;
  readonly dndIcon: boolean;
  readonly popupWindow: boolean;
  readonly specialWindow: boolean;
  readonly managed: boolean;
  readonly deleted: boolean;
  readonly transient: boolean;
  readonly transientFor: KWindow | null;
  readonly modal: boolean;
  readonly resizeable: boolean;
  readonly moveable: boolean;
  readonly skipTaskbar: boolean;
  readonly output: KOutput | null;
  desktops: KDesktop[];
  readonly onAllDesktops: boolean;
  readonly activities: string[];
  readonly minimized: boolean;
  readonly fullScreen: boolean;
  readonly maximizeMode: number;
  readonly move: boolean;
  readonly resize: boolean;
  readonly hidden: boolean;
  frameGeometry: KRect;
  readonly clientGeometry: KRect;
  readonly minSize: KSize;
  readonly maxSize: KSize;
  readonly tile: KTile | null;
  noBorder: boolean;

  readonly frameGeometryChanged: KSignal;
  readonly minimizedChanged: KSignal;
  readonly fullScreenChanged: KSignal;
  readonly maximizedChanged: KSignal;
  readonly moveResizedChanged: KSignal;
  readonly interactiveMoveResizeStarted: KSignal;
  readonly interactiveMoveResizeFinished: KSignal;
  readonly outputChanged: KSignal;
  readonly desktopsChanged: KSignal;
  readonly activitiesChanged: KSignal;
  readonly tileChanged: KSignal;
  readonly captionChanged: KSignal;
  readonly windowClassChanged: KSignal;
  readonly transientChanged: KSignal;
  readonly hiddenChanged: KSignal;
  readonly modalChanged: KSignal;
  /** Emitted on every xdg-toplevel min/max size change; X11: when the maximize action flips (measured, 6.7.5). */
  readonly maximizeableChanged: KSignal;
  /** Decoration created or destroyed; the client geometry (margin) follows in clientGeometryChanged (measured). */
  readonly decorationChanged: KSignal;
  readonly clientGeometryChanged: KSignal;
}

export interface KList<T> {
  readonly length: number;
  readonly [index: number]: T;
}

export interface KWorkspace {
  readonly windows: KList<KWindow>;
  readonly screens: KList<KOutput>;
  readonly desktops: KList<KDesktop>;
  readonly activities: KList<string>;
  readonly currentActivity: string;
  activeWindow: KWindow | null;
  readonly activeScreen: KOutput | null;
  readonly MaximizeArea: number;
  currentDesktopForScreen(o: KOutput): KDesktop | null;
  /** Q_INVOKABLE in 6.7.5 and 6.8.0; switches every output unless desktops are per output (exercised by O08). */
  setCurrentDesktopForScreen(d: KDesktop, o: KOutput): void;
  clientArea(option: number, output: KOutput, desktop: KDesktop): KRect;
  raiseWindow(w: KWindow): void;
  sendClientToScreen(w: KWindow, o: KOutput): void;

  readonly windowAdded: KSignal<[KWindow]>;
  readonly windowRemoved: KSignal<[KWindow]>;
  readonly windowActivated: KSignal<[KWindow | null]>;
  readonly currentDesktopChanged: KSignal;
  readonly currentActivityChanged: KSignal;
  readonly activitiesChanged: KSignal;
  readonly screensChanged: KSignal;
  readonly screenOrderChanged: KSignal;
  readonly desktopsChanged: KSignal;
  readonly virtualScreenGeometryChanged: KSignal;
}

export interface KQt {
  rect(x: number, y: number, w: number, h: number): KRect;
  callLater(fn: () => void): void;
}

export interface KKWin {
  readConfig(key: string, defaultValue: unknown): unknown;
}

export interface KOptions {
  readonly configChanged: KSignal;
}
