"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

export default function EyesPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [wakeLock, setWakeLock] = useState<WakeLockSentinel | null>(null);
  const miaStateRef = useRef<string>("IDLE");
  const lastServerStateRef = useRef<number>(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSpokenRef = useRef<string>("");

  useEffect(() => {
    const es = new EventSource("/api/mia-state");
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.state) {
          miaStateRef.current = d.state;
          lastServerStateRef.current = performance.now();
          if (d.state === "SPEAKING" && d.text && d.text !== lastSpokenRef.current) {
            lastSpokenRef.current = d.text;
            const audio = audioRef.current || (audioRef.current = new Audio());
            fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: d.text.slice(0, 400) }) })
              .then((r) => r.ok ? r.arrayBuffer() : Promise.reject())
              .then((buf) => {
                const blob = new Blob([buf], { type: "audio/wav" });
                audio.src = URL.createObjectURL(blob);
                audio.play().catch(() => {});
              }).catch(() => {});
          }
        }
      } catch {}
    };
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("mia-state");
      bc.onmessage = (e) => {
        if (e.data?.state) {
          miaStateRef.current = e.data.state;
          lastServerStateRef.current = performance.now();
          if (e.data.state === "SPEAKING" && e.data.text && e.data.text !== lastSpokenRef.current) {
            lastSpokenRef.current = e.data.text;
            const audio = audioRef.current || (audioRef.current = new Audio());
            fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: e.data.text.slice(0, 400) }) })
              .then((r) => r.ok ? r.arrayBuffer() : Promise.reject())
              .then((buf) => {
                const blob = new Blob([buf], { type: "audio/wav" });
                audio.src = URL.createObjectURL(blob);
                audio.play().catch(() => {});
              }).catch(() => {});
          }
        }
      };
    } catch {}
    return () => { es.close(); try { bc?.close(); } catch {} };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    let raf = 0;
    const leftEyeX = 45, rightEyeX = 80, eyeY = 18;
    let eyeWidth = 25, eyeHeight = 30;
    let targetOffsetX = 0, targetOffsetY = 0;
    let offsetX = 0, offsetY = 0;
    let blinkState = 0;
    let lastBlinkTime = performance.now();
    let moveTime = performance.now();
    let sx = 1, sy = 1, cx = 0, cy = 0;
    let dpr = 1;

    const updateMetrics = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sx = window.innerWidth / 128;
      sy = window.innerHeight / 64;
      cx = window.innerWidth / 2 - 64 * sx;
      cy = window.innerHeight / 2 - 32 * sy;
    };
    updateMetrics();
    window.addEventListener("resize", updateMetrics);

    const drawEye = (x: number, y: number, w: number, h: number, state: string) => {
      const px = x * sx, py = y * sy, pw = w * sx, ph = h * sy, r = 5 * sx;
      ctx.fillStyle = "white";
      ctx.beginPath();
      if ((ctx as unknown as { roundRect?: unknown }).roundRect) (ctx as unknown as { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(px, py, pw, ph, r);
      else { ctx.moveTo(px + r, py); ctx.arcTo(px + pw, py, px + pw, py + ph, r); ctx.arcTo(px + pw, py + ph, px, py + ph, r); ctx.arcTo(px, py + ph, px, py, r); ctx.arcTo(px, py, px + pw, py, r); }
      ctx.fill();
      if (state !== "INTERRUPTED" && h > 16) {
        const pupilScale = state === "LISTENING" ? 0.36 : state === "PROCESSING" ? 0.22 : state === "SPEAKING" ? 0.30 : 0.28;
        const pupilR = Math.min(pw, ph) * pupilScale;
        const pupilX = px + pw / 2 + offsetX * sx * 0.18;
        const pupilY = py + ph / 2 + offsetY * sy * 0.18;
        ctx.fillStyle = "black";
        ctx.beginPath(); ctx.arc(pupilX, pupilY, pupilR, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.beginPath(); ctx.arc(pupilX + pupilR * 0.38, pupilY - pupilR * 0.32, pupilR * 0.38, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.beginPath(); ctx.arc(pupilX - pupilR * 0.25, pupilY + pupilR * 0.25, pupilR * 0.18, 0, Math.PI * 2); ctx.fill();
      }
    };

    const loop = () => {
      const now = performance.now();
      const hasServerState = now - lastServerStateRef.current < 1500;
      const curState = hasServerState ? miaStateRef.current : "AUTO";
      const speed = hasServerState ? 4 : 2;
      const curBlinkDelay = curState === "LISTENING" ? 5500 : curState === "SPEAKING" ? 2200 : curState === "PROCESSING" ? 7000 : 4000;
      if (now - lastBlinkTime > curBlinkDelay && blinkState === 0) {
        blinkState = 1;
        lastBlinkTime = now;
      } else if (now - lastBlinkTime > 110 && blinkState === 1) {
        blinkState = 0;
        lastBlinkTime = now;
      }
      if (hasServerState && blinkState === 0) {
        if (curState === "LISTENING") { targetOffsetX = 0; targetOffsetY = 0; eyeHeight = 36; eyeWidth = 28; }
        else if (curState === "PROCESSING") { targetOffsetX = 0; targetOffsetY = -10; eyeHeight = 22; eyeWidth = 30; }
        else if (curState === "SPEAKING") { targetOffsetX = Math.sin(now / 180) * 5; targetOffsetY = Math.sin(now / 350) * 1.5; eyeHeight = 30; eyeWidth = 25; }
        else if (curState === "INTERRUPTED") { targetOffsetX = 0; targetOffsetY = 0; eyeHeight = 14; eyeWidth = 32; }
        else { targetOffsetX = 0; targetOffsetY = 0; eyeHeight = 30; eyeWidth = 25; }
      } else if (!hasServerState && now - moveTime > (1200 + Math.random() * 1000) && blinkState === 0) {
        const t = Math.floor(Math.random() * 6);
        if (t === 0) { targetOffsetX = -10; targetOffsetY = 0; }
        else if (t === 1) { targetOffsetX = 10; targetOffsetY = 0; }
        else if (t === 2) { targetOffsetX = 0; targetOffsetY = -8; }
        else if (t === 3) { targetOffsetX = 0; targetOffsetY = 8; }
        else { targetOffsetX = 0; targetOffsetY = 0; }
        moveTime = now;
      }
      offsetX += (targetOffsetX - offsetX) / speed;
      offsetY += (targetOffsetY - offsetY) / speed;

      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

      ctx.save();
      ctx.translate(cx, cy);
      if (blinkState === 0) {
        drawEye(leftEyeX + offsetX, eyeY + offsetY, eyeWidth, eyeHeight, curState);
        drawEye(rightEyeX + offsetX, eyeY + offsetY, eyeWidth, eyeHeight, curState);
      } else {
        ctx.fillStyle = "white";
        ctx.fillRect((leftEyeX + offsetX) * sx, (eyeY + offsetY + eyeHeight / 2 - 2) * sy, eyeWidth * sx, 3 * sy);
        ctx.fillRect((rightEyeX + offsetX) * sx, (eyeY + offsetY + eyeHeight / 2 - 2) * sy, eyeWidth * sx, 3 * sy);
      }
      ctx.restore();

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateMetrics);
    };
  }, []);

  const requestWakeLock = async () => {
    try {
      const lock = await (navigator as unknown as { wakeLock?: { request: (s: string) => Promise<WakeLockSentinel> } }).wakeLock?.request("screen");
      if (lock) setWakeLock(lock);
    } catch {}
  };

  const [debugState, setDebugState] = useState("IDLE");
  useEffect(() => {
    const id = setInterval(() => setDebugState(miaStateRef.current), 200);
    return () => clearInterval(id);
  }, []);

  return (
    <main className="relative h-dvh w-dvw overflow-hidden bg-black">
      <canvas ref={canvasRef} className="h-full w-full" />
      <div className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-xs text-white/60 backdrop-blur">
        {debugState}
      </div>
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2">
        <button onClick={requestWakeLock} className="rounded-full bg-white/10 px-4 py-2 text-xs text-white backdrop-blur">
          {wakeLock ? "Layar tetap nyala ✓" : "Jaga layar tetap nyala"}
        </button>
        <Link href="/" className="rounded-full bg-white/10 px-4 py-2 text-xs text-white backdrop-blur">← Mia</Link>
      </div>
      <p className="absolute top-12 left-1/2 -translate-x-1/2 text-[10px] text-white/30">Add to Home Screen untuk fullscreen • HP tetap di charger</p>
    </main>
  );
}
