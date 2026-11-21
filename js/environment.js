import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { clamp, smoothstep, Settings } from './config.js';
import { fbm } from './world/noise.js';
import { WORLD } from './world/world.js';
import { game } from './main.js';

// ============================== Environment (Tag/Nacht) ==============================
/**
 * Himmel (Verlauf, Sonne/Mond, Sterne, Wolken), Licht, Nebel, Umgebungs-
 * Reflexionen und – auf „Hoch“ – Bloom (Leuchten von Lichtern).
 */
class Environment {
  constructor(game) {
    this.g = game; this.scene = game.scene; this.renderer = game.renderer; this.q = game.q;
    this.hemi = new THREE.HemisphereLight(0xbfdcff, 0x5a6040, 0.9);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 3);
    this.sunDir = new THREE.Vector3(-0.5, 0.5, 0.42).normalize();
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0003; this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.scene.fog = new THREE.Fog(0xbcd6ea, 300, 2000);

    this.uniforms = {
      uTop: { value: new THREE.Color(0x2f6fd0) }, uHorizon: { value: new THREE.Color(0xbcd6ea) },
      uSunDir: { value: this.sunDir.clone() }, uNight: { value: 0 }, uTime: { value: 0 }, uClouds: { value: this.q.clouds ? (this.q.physicalPaint ? 2 : 1) : 0 }, uCover: { value: 1 }, uGrey: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms: this.uniforms,
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
      fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform float uNight; uniform float uTime; uniform float uClouds; uniform float uCover; uniform float uGrey;
        varying vec3 vDir;
        float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
        float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p *= 2.03; a *= 0.5; } return s; }
        void main(){
          vec3 d = normalize(vDir);
          float h = max(d.y, 0.0);
          vec3 col = mix(uHorizon, uTop, pow(h, 0.48));
          if (d.y < 0.0) col = mix(uHorizon, uHorizon * 0.6, clamp(-d.y * 4.0, 0.0, 1.0));
          // Physikalisch angelehnter Taghimmel: Rayleigh- (blau) und Mie-Streuung (Dunst um die Sonne) mit Luftmassen-
          // Näherung; tiefe Sonne → längerer Lichtweg → orange-roter Horizont. Wetter mischt Richtung Grau.
          if (uNight < 0.5) {
            vec3 sdir = normalize(uSunDir);
            vec3 bR = vec3(5.8e-3, 13.5e-3, 33.1e-3) * 1.0, bM = vec3(4e-3);
            float zv = max(d.y, 0.0) + 0.02, zs = max(sdir.y, 0.0) + 0.02;
            float mV = 1.0 / (zv + 0.15 * pow(max(93.885 - degrees(acos(clamp(zv, 0.0, 1.0))), 0.01), -1.253));
            float mS = 1.0 / (zs + 0.15 * pow(max(93.885 - degrees(acos(clamp(zs, 0.0, 1.0))), 0.01), -1.253));
            float cosT = dot(d, sdir);
            float pR = 0.0596831 * (1.0 + cosT * cosT);
            float g = 0.76, pM = 0.0795775 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5);
            vec3 extV = exp(-(bR * 8.4 + bM * 1.25) * mV), extS = exp(-(bR * 8.4 + bM * 1.25) * mS);
            vec3 sky = (bR * pR + bM * pM) / (bR + bM) * (1.0 - extV) * extS * 14.0;
            sky += vec3(0.02, 0.025, 0.035);                                       // Mehrfachstreuung (Grundhelligkeit)
            if (d.y < 0.0) sky = mix(sky, uHorizon * 0.6, clamp(-d.y * 4.0, 0.0, 1.0));
            col = mix(sky, col, clamp(uGrey, 0.0, 1.0));
          }
          float sd = max(dot(d, normalize(uSunDir)), 0.0);
          if (uNight < 0.5) {
            col += vec3(1.0, 0.92, 0.75) * (pow(sd, 1200.0) * 40.0 + pow(sd, 10.0) * 0.22 + pow(sd, 2.0) * 0.05);
          } else {
            col += vec3(0.85, 0.9, 1.0) * (smoothstep(0.99935, 0.9996, sd) * 3.0 + pow(sd, 80.0) * 0.08);
            vec2 sp = d.xz / (d.y + 0.35) * 260.0;
            float st = step(0.9968, h21(floor(sp))) * smoothstep(0.03, 0.25, d.y);
            col += vec3(st) * (0.55 + 0.45 * sin(uTime * 2.0 + h21(floor(sp) + 3.1) * 40.0));
          }
          if (uClouds > 1.5 && d.y > 0.02) {
            // Volumetrisch wirkende Wolken (Grafik Hoch): Strahl durch eine Wolkenschicht, 6 Schritte Dichte,
            // je Schritt eine Lichtprobe Richtung Sonne → helle, sonnenbeschienene Ränder, dunkle Unterseiten
            float cv = uCover - 1.0, T = 1.0; vec3 acc = vec3(0.0);
            vec3 sdir2 = normalize(uSunDir);
            for (int i = 0; i < 6; i++) {
              float hh = 0.6 + float(i) * 0.18;                                  // Höhe in der Schicht
              vec2 cp = d.xz / d.y * hh * 1.4 + vec2(uTime * 0.004, uTime * 0.0016);
              float den = smoothstep(0.52 - 0.3 * cv - float(i) * 0.012, 0.9, fbm(cp) + 0.08 * (1.0 - abs(float(i) - 2.5) / 2.5));
              if (den > 0.01) {
                float lt = fbm(cp + sdir2.xz * 0.35);
                float shade = exp(-max(lt - 0.45, 0.0) * 4.0);
                vec3 lc = uNight > 0.5 ? vec3(0.03, 0.035, 0.05) : mix(vec3(0.55, 0.6, 0.68), vec3(1.08, 1.02, 0.95), shade) * (1.0 - 0.45 * clamp(cv, 0.0, 1.0));
                lc += (uNight > 0.5 ? 0.0 : 1.0) * vec3(0.35, 0.22, 0.1) * pow(max(dot(d, sdir2), 0.0), 8.0);
                lc *= mix(vec3(1.0), uHorizon * 1.35, 0.55);                     // Wolken nehmen die Himmelsfarbe an (abends rosa-orange)
                float a = den * 0.38;
                acc += T * a * lc; T *= 1.0 - a;
              }
            }
            col = col * mix(1.0, T, smoothstep(0.02, 0.16, d.y)) + acc * smoothstep(0.02, 0.16, d.y);
          } else if (uClouds > 0.0 && d.y > 0.0) {
            vec2 cp = d.xz / (d.y + 0.1) * 1.4 + vec2(uTime * 0.004, uTime * 0.0016);
            float cv = uCover - 1.0;
            float c = smoothstep(0.5 - 0.3 * cv, 0.82 - 0.12 * cv, fbm(cp));
            vec3 cc = uNight > 0.5 ? vec3(0.025, 0.03, 0.045) : mix(vec3(1.02), vec3(0.66, 0.7, 0.76), smoothstep(0.55, 0.95, fbm(cp * 1.8 + 3.0)));
            cc += (uNight > 0.5 ? 0.0 : 1.0) * vec3(0.25, 0.2, 0.1) * pow(sd, 6.0);
            cc *= 1.0 - 0.42 * clamp(cv, 0.0, 1.0);
            col = mix(col, cc, c * smoothstep(0.0, 0.16, d.y) * 0.92);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2600, 32, 16), mat);
    this.sky.frustumCulled = false; this.sky.renderOrder = -1;
    this.scene.add(this.sky);
    this.envScene = new THREE.Scene();
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat));
    this.envGround = new THREE.Mesh(new THREE.CircleGeometry(9.5, 24).rotateX(-Math.PI / 2).translate(0, -1.2, 0), new THREE.MeshBasicMaterial({ color: 0x4a5236 }));
    this.envScene.add(this.envGround);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.composer = null;
  }

  /** Bloom-Nachbearbeitung (nur Grafikstufe „Hoch“). */
  setupBloom() {
    if (!this.q.bloom) { this.composer = null; return; }
    const r = this.renderer;
    const size = r.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.g.camera));
    // Umgebungsverdeckung (GTAO, halbe Auflösung): dunkelt Ecken, Spalten, Kontaktstellen ab – nur Grafik Hoch
    try {
      const ao = this.ao = new GTAOPass(this.scene, this.g.camera, size.x / 2, size.y / 2);
      const setSz = ao.setSize.bind(ao); ao.setSize = (w, h) => setSz(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
      ao.blendIntensity = 0.85;
      // Durchsichtige Effekte (Flammen, Partikel, Lichtschein, Glas, Regen) dürfen nicht in die AO-Tiefe/Normalen –
      // sonst erscheinen sie als dunkle Kästen. Für den AO-Durchgang kurz ausblenden.
      const aoRender = ao.render.bind(ao), hidden = [];
      ao.render = (...args) => {
        this.scene.traverse((o) => {
          if (!o.visible) return;
          const m = o.material;
          if (o.isSprite || o.isPoints || o.isLine || (m && (Array.isArray(m) ? m.some((x) => x.transparent) : m.transparent))) { o.visible = false; hidden.push(o); }
        });
        try { aoRender(...args); } finally { for (const o of hidden) o.visible = true; hidden.length = 0; }
      };
      ao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 1.2, scale: 1, samples: 10, distanceFallOff: 1, screenSpaceRadius: false });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 8 });
      this.composer.addPass(ao);
    } catch (e) { this.ao = null; }
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.35, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // Filmische Farbkorrektur: leichte S-Kurve, warme Lichter/kühle Schatten, feines Korn, minimale Farbsäume am Rand
    this.grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uWarm: { value: 1 }, uBlur: { value: 0 }, uFilm: { value: 0 }, uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 768) }, uSunUV: { value: new THREE.Vector2(0.5, 0.8) }, uRays: { value: 0 }, uRayCol: { value: new THREE.Color(1, 0.92, 0.75) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; uniform float uWarm; uniform float uBlur; uniform float uFilm; uniform vec2 uTexel; uniform vec2 uSunUV; uniform float uRays; uniform vec3 uRayCol; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main(){
          vec2 d = vUv - 0.5; float r = dot(d, d);
          // Farbsäume nur mit Film-Look; sonst exakt das scharfe Bild
          float ca = 0.012 * uFilm;
          vec3 c; c.r = texture2D(tDiffuse, vUv + d * r * ca).r; c.g = texture2D(tDiffuse, vUv).g; c.b = texture2D(tDiffuse, vUv - d * r * ca).b;
          // leichtes Nachschärfen (Unsharp-Mask aus 4 Nachbarpixeln) gegen weiches Bild
          vec3 nb = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb
                  + texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
          c = max(c + (c - nb * 0.25) * 0.35, 0.0);
          // Lichtstrahlen der Sonne (Crepuscular Rays): helle Bildteile (Himmel zwischen Ästen/Häusern)
          // werden zur Sonnenposition hin verschmiert – wirkt wie Licht in leicht dunstiger Luft
          if (uRays > 0.001) {
            vec2 dlt = (uSunUV - vUv) / 18.0; vec2 sp = vUv; float ill = 0.0, dec = 1.0;
            for (int i = 0; i < 18; i++) { sp += dlt; vec3 s = texture2D(tDiffuse, sp).rgb; float l = dot(s, vec3(0.3, 0.59, 0.11));
              ill += smoothstep(0.72, 1.0, l) * dec; dec *= 0.93; }
            c += uRayCol * ill / 18.0 * uRays * smoothstep(1.2, 0.0, length(uSunUV - vUv));
          }
          // Bewegungsunschärfe bei hohem Tempo: radial vom Bildzentrum, Mitte bleibt scharf
          if (uBlur > 0.001) { vec2 st = d * uBlur * smoothstep(0.02, 0.2, r) * 0.06; vec3 acc = c;
            for (int i = 1; i <= 4; i++) acc += texture2D(tDiffuse, vUv - st * float(i)).rgb;
            c = acc / 5.0; }
          c = mix(c, c * c * (3.0 - 2.0 * c), 0.22);                       // Kontrast-S-Kurve
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          c += (vec3(0.035, 0.015, -0.03) * smoothstep(0.45, 1.0, l) + vec3(-0.02, 0.0, 0.03) * (1.0 - smoothstep(0.0, 0.4, l))) * uWarm;
          c = mix(vec3(l), c, 1.06);                                         // etwas mehr Sättigung
          c += (h(vUv * 1000.0 + uTime) - 0.5) * 0.025 * uFilm;              // Filmkorn (nur Film-Look)
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.composer.addPass(this.grade);
    this.applyBloomParams();
  }
  applyBloomParams() {
    if (!this.bloom) return;
    this.bloom.strength = this.night ? 0.6 : 0.2;
    this.bloom.threshold = this.night ? 0.78 : 0.95;
    this.bloom.radius = this.night ? 0.55 : 0.4;
  }
  resize(w, h) {
    if (!this.composer) return;
    this.composer.setSize(w, h); this.composer.setPixelRatio(this.renderer.getPixelRatio());
    const pr = this.renderer.getPixelRatio();
    if (this.grade) this.grade.uniforms.uTexel.value.set(1 / (w * pr), 1 / (h * pr));   // Nachschärfen pixelgenau
  }

  setTime(mode) {
    const night = mode === 'night', dusk = mode === 'dusk';
    this.night = night;
    const u = this.uniforms;
    u.uNight.value = night ? 1 : 0;
    if (night) {
      u.uTop.value.set(0x020610); u.uHorizon.value.set(0x0d1626);
      this.sunDir.set(0.35, 0.55, -0.55).normalize();              // Mond
      this.sun.color.set(0x9bb4ff); this.sun.intensity = 0.32;
      this.hemi.color.set(0x22324f); this.hemi.groundColor.set(0x08090b); this.hemi.intensity = 0.32;
      this.scene.fog.color.set(0x0a111c); this.scene.fog.near = 120; this.scene.fog.far = Math.min(1300, this.q.fogFar);
      this.renderer.toneMappingExposure = this.baseExposure = 1.15;
      this.envGround.material.color.set(0x050607);
    } else if (dusk) {
      // Abendsonne: tief, warm, lange Schatten
      u.uTop.value.set(0x2d3f78); u.uHorizon.value.set(0xf6a56a);
      this.sunDir.set(-0.78, 0.13, 0.6).normalize();
      this.sun.color.set(0xffa55e); this.sun.intensity = 2.4;
      this.hemi.color.set(0x8d8fb8); this.hemi.groundColor.set(0x4a3a2a); this.hemi.intensity = 0.55;
      this.scene.fog.color.set(0xd99a72); this.scene.fog.near = 110; this.scene.fog.far = this.q.fogFar * 0.95;   // warmer Dunst
      this.renderer.toneMappingExposure = this.baseExposure = 1.05;
      this.envGround.material.color.set(0x3a2e24);
    } else {
      u.uTop.value.set(0x2f6fd0); u.uHorizon.value.set(0xbcd6ea);
      this.sunDir.set(-0.5, 0.5, 0.42).normalize();
      this.sun.color.set(0xffe9cf); this.sun.intensity = 3.2;
      this.hemi.color.set(0xbfdcff); this.hemi.groundColor.set(0x5a6040); this.hemi.intensity = 0.85;
      this.scene.fog.color.set(0xbcd6ea); this.scene.fog.near = 130; this.scene.fog.far = this.q.fogFar * 1.12;    // leichter Dunst, Ferne bleibt sichtbar
      this.renderer.toneMappingExposure = this.baseExposure = 0.95;
      this.envGround.material.color.set(0x4a5236);
    }
    u.uSunDir.value.copy(this.sunDir);
    // Reflexionen aus dem aktuellen Himmel neu berechnen
    const old = this.scene.environment;
    this.scene.environment = this.pmrem.fromScene(this.envScene, 0.03).texture;
    this.scene.environmentIntensity = night ? 0.3 : dusk ? 0.55 : 0.7;
    if (this.grade) this.grade.uniforms.uWarm.value = night ? 0.4 : dusk ? 1.6 : 1;
    old?.dispose?.();
    this.applyBloomParams();
  }

  /** Augen-Anpassung (k > 0: dunkle Umgebung → Belichtung hoch) und Bewegungsunschärfe (0..1). */
  setAdapt(k, blur) {
    this.adaptK = k;
    if (this.grade) { const U = this.grade.uniforms; U.uBlur.value = Settings.data.blurFx ? blur : 0; U.uFilm.value = Settings.data.filmLook ? 1 : 0; }
  }

  /** Sonnenposition auf dem Bildschirm für die Lichtstrahlen (pro Bild, nur Grafik Hoch). */
  updateRays(camera) {
    if (!this.grade) return;
    const U = this.grade.uniforms, p = this._sunP || (this._sunP = new THREE.Vector3());
    p.copy(camera.position).addScaledVector(this.sunDir, 1000).project(camera);
    const inFront = p.z < 1, on = inFront && !this.night && Math.abs(p.x) < 1.6 && Math.abs(p.y) < 1.6;
    U.uSunUV.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    const tgt = on ? (this.sunDir.y < 0.25 ? 0.9 : 0.55) * (1 - Math.min(1, Math.hypot(p.x, p.y) / 1.6)) : 0;
    U.uRays.value += (tgt - U.uRays.value) * 0.1;
    U.uRayCol.value.set(this.sunDir.y < 0.25 ? 0xffb070 : 0xfff0d0);
  }

  update(dt, focus, camPos) {
    this.uniforms.uTime.value += dt;
    // Belichtung folgt der Umgebungshelligkeit träge wie das Auge (~1,5 s)
    if (this.baseExposure) { const tgt = this.baseExposure * (1 + (this.adaptK || 0)); this.renderer.toneMappingExposure += (tgt - this.renderer.toneMappingExposure) * (1 - Math.exp(-dt / 1.5)); }
    if (this.grade) this.grade.uniforms.uTime.value = this.uniforms.uTime.value % 100;
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 200);
    this.sky.position.copy(camPos);
    // Mond: helle Scheibe mit Mondmeeren und Lichthof in Richtung des Mondlichts (nur nachts)
    if (!this.moon) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c = cv.getContext('2d');
      const hg = c.createRadialGradient(64, 64, 18, 64, 64, 64); hg.addColorStop(0, 'rgba(200,215,255,0.35)'); hg.addColorStop(1, 'rgba(200,215,255,0)');
      c.fillStyle = hg; c.fillRect(0, 0, 128, 128);
      c.fillStyle = '#eef1f6'; c.beginPath(); c.arc(64, 64, 20, 0, 6.3); c.fill();
      c.fillStyle = 'rgba(150,158,172,0.55)'; for (const [x, y, r] of [[58, 58, 6], [70, 66, 5], [62, 72, 3.5], [72, 55, 3]]) { c.beginPath(); c.arc(x, y, r, 0, 6.3); c.fill(); }
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
      this.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, fog: false, depthWrite: false, transparent: true, toneMapped: false }));
      this.moon.scale.setScalar(260); this.moon.renderOrder = -0.4; this.scene.add(this.moon);
    }
    this.moon.visible = !!this.night;
    if (this.night) this.moon.position.copy(camPos).addScaledVector(this.sunDir, 3000);
  }

  render(camera) {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, camera);
  }
}

// ============================== Minimap ==============================
/** Kleine, mitdrehende Karte oben links (Straßen, Wasser, Stadt, Verkehr). */
class Minimap {
  constructor(world) {
    this.w = world;
    this.el = document.getElementById('minimap');
    this.ctx = this.el.getContext('2d');
    const S = 512, half = world.half, k = S / (half * 2);
    this.k = k;
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const c = cv.getContext('2d');
    // Gelände (Farben aus dem Raster, abgedunkelt)
    const img = c.createImageData(S, S), d = img.data, n = world.n;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = Math.min(n - 1, Math.round(x / S * (n - 1))), j = Math.min(n - 1, Math.round(y / S * (n - 1)));
      const idx = j * n + i, p = (y * S + x) * 4;
      if (world.H[idx] < world.waterLevel) { d[p] = 40; d[p + 1] = 90; d[p + 2] = 130; }
      else { d[p] = world.col[idx * 3] * 0.55; d[p + 1] = world.col[idx * 3 + 1] * 0.55; d[p + 2] = world.col[idx * 3 + 2] * 0.55; }
      d[p + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    const tx = (x) => (x + half) * k;
    c.fillStyle = 'rgba(60,62,66,1)';
    for (const b of world.buildings) c.fillRect(tx(b.x0), tx(b.z0), (b.x1 - b.x0) * k, (b.z1 - b.z0) * k);
    const A = WORLD.air; c.fillStyle = '#55575b'; c.fillRect(tx(A.cx - A.hx), tx(A.cz - 30), A.hx * 2 * k, 60 * k);
    const draw = (cls, width, color) => {
      c.strokeStyle = color; c.lineWidth = width; c.lineJoin = 'round'; c.lineCap = 'round';
      for (const e of world.edges) {
        if (e.cls !== cls) continue;
        c.beginPath(); e.pts.forEach((p, i) => (i ? c.lineTo(tx(p.x), tx(p.z)) : c.moveTo(tx(p.x), tx(p.z)))); c.stroke();
      }
    };
    draw('city', 2, '#c9c9c9'); draw('avenue', 3.2, '#d8d8d8'); draw('park', 1.4, '#c9c9c9'); draw('ring', 2, '#c9c9c9'); draw('country', 2.2, '#e8dcc0'); draw('highway', 3.4, '#f0a640');
    this.map = cv;
    this.t = 0;
  }

  draw(dt, vehicle, traffic) {
    if ((this.t -= dt) > 0) return;
    this.t = 0.07;
    const c = this.ctx, Wd = this.el.width, R = Wd / 2;
    const half = this.w.half, k = this.k;
    const zoom = 2.6;                        // Kartenpixel → Minimap-Pixel
    c.clearRect(0, 0, Wd, Wd);
    c.save();
    c.beginPath(); c.arc(R, R, R - 2, 0, Math.PI * 2); c.clip();
    c.fillStyle = '#10141a'; c.fillRect(0, 0, Wd, Wd);
    c.translate(R, R);
    c.rotate(vehicle.yaw());
    c.scale(zoom, zoom);
    c.translate(-(vehicle.pos.x + half) * k, -(vehicle.pos.z + half) * k);
    c.drawImage(this.map, 0, 0);
    c.fillStyle = '#ffffff';
    if (traffic) for (const car of traffic.cars) c.fillRect((car.x + half) * k - 0.7, (car.z + half) * k - 0.7, 1.4, 1.4);
    const ms = window.__game?.missions;
    if (ms && !ms.active) for (const mk of ms.markers) if (mk.grp.visible) { c.fillStyle = '#ffc13b'; c.fillRect((mk.p.x + half) * k - 2.2, (mk.p.z + half) * k - 2.2, 4.4, 4.4); }
    const pol = window.__game?.police;
    if (pol?.active) {
      const blink = (pol.time * 4 | 0) % 2;
      for (const u of pol.units) if (u.active) { c.fillStyle = blink ? '#3d6bff' : '#ff3b4e'; c.beginPath(); c.arc((u.pos.x + half) * k, (u.pos.z + half) * k, 2.2, 0, 6.3); c.fill(); }
      if (pol.heli && pol.D.heli) { c.strokeStyle = '#ffd23f'; c.lineWidth = 1; c.beginPath(); c.arc((pol.heli.pos.x + half) * k, (pol.heli.pos.z + half) * k, 3, 0, 6.3); c.stroke(); }
    }
    c.restore();
    // Spielerpfeil (zeigt immer nach oben)
    c.fillStyle = '#36e0ff'; c.strokeStyle = '#031018'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(R, R - 9); c.lineTo(R + 6, R + 7); c.lineTo(R, R + 3); c.lineTo(R - 6, R + 7); c.closePath(); c.fill(); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 2; c.beginPath(); c.arc(R, R, R - 2, 0, Math.PI * 2); c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.8)'; c.font = 'bold 11px sans-serif'; c.textAlign = 'center';
    c.save(); c.translate(R, R); c.rotate(vehicle.yaw()); c.fillText('N', 0, -R + 14); c.restore();
  }
}

/**
 * Glättet Normalen einer nicht-indizierten Geometrie, behält aber harte Kanten
 * über dem Knickwinkel (wie BufferGeometryUtils.toCreasedNormals, ohne Addon).
 */
function smoothNormals(g, creaseDeg = 40) {
  const pos = g.attributes.position, n = pos.count;
  const cos = Math.cos(creaseDeg * Math.PI / 180);
  const faceN = new Float32Array(n * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    c.sub(b); b.sub(a); c.cross(b).normalize().negate();
    for (let k = 0; k < 3; k++) faceN.set([c.x, c.y, c.z], (i + k) * 3);
  }
  const key = (i) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const groups = new Map();
  for (let i = 0; i < n; i++) { const k = key(i); let arr = groups.get(k); if (!arr) groups.set(k, arr = []); arr.push(i); }
  const out = new Float32Array(n * 3);
  for (const arr of groups.values()) {
    for (const i of arr) {
      let x = 0, y = 0, z = 0;
      const fx = faceN[i * 3], fy = faceN[i * 3 + 1], fz = faceN[i * 3 + 2];
      for (const j of arr) {
        const gx = faceN[j * 3], gy = faceN[j * 3 + 1], gz = faceN[j * 3 + 2];
        if (fx * gx + fy * gy + fz * gz >= cos) { x += gx; y += gy; z += gz; }
      }
      const l = Math.hypot(x, y, z) || 1;
      out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
    }
  }
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
}

/** Keil: Grundfläche width×len, steigt in −Z-Richtung auf height. */
function makeWedge(w, h, l) {
  const hw = w / 2, hl = l / 2;
  // Ecken: Start (z=+hl, Höhe 0), Ende (z=−hl, Höhe h)
  const v = [
    [-hw, 0, hl], [hw, 0, hl], [hw, 0, -hl], [-hw, 0, -hl],   // Boden 0..3
    [-hw, h, -hl], [hw, h, -hl],                              // Oberkante 4,5
  ];
  const faces = [
    [0, 1, 5], [0, 5, 4],     // Rampenfläche
    [3, 4, 5], [3, 5, 2],     // Rückwand
    [0, 4, 3], [1, 2, 5],     // Seiten
    [0, 3, 2], [0, 2, 1],     // Boden
  ];
  const pos = [];
  for (const f of faces) for (const i of f) pos.push(...v[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // einfache planare UVs
  const uv = []; for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] * 0.25, pos[i + 2] * 0.25);
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Erzeugt eine kachelbare Rauschtextur (keine externen Dateien). */
function makeNoiseTexture(size, rgb, spread) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = (Math.random() - 0.5) * spread;
    img.data[i * 4] = clamp(rgb[0] + n, 0, 255);
    img.data[i * 4 + 1] = clamp(rgb[1] + n, 0, 255);
    img.data[i * 4 + 2] = clamp(rgb[2] + n, 0, 255);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export { Environment, Minimap, smoothNormals, makeWedge, makeNoiseTexture };
