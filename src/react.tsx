"use client";

import { useEffect, useRef } from "react";
import { SkyEngine } from "./engine";
import type { Theme } from "./renderer";
import type { RaptorSpec } from "./world";

/** Glyphs come from the canvas's font-family, so give it (or a parent) a monospace font. */
export function AsciiSky({ className, raptors, theme = "dark" }: { className?: string; raptors?: RaptorSpec[]; theme?: Theme }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<SkyEngine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new SkyEngine(canvas, raptors);
    engine.setTheme(theme);
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
    // The roster is fixed for the life of the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setTheme(theme);
  }, [theme]);

  return <canvas ref={canvasRef} aria-hidden="true" className={`ascii-sky ${className ?? ""}`} />;
}
